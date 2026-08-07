import type { ControllerContainer } from "./container.js";

const POST_BOOT_CLOUD_REFRESH_DELAY_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function bootstrapController(
  container: ControllerContainer,
): Promise<() => void> {
  // Run independent prep tasks in parallel to shave off startup time.
  // Cloud model hydration is deliberately not part of the readiness path.
  // A blocked proxy or slow cloud endpoint must not prevent the local
  // controller/OpenClaw pair from becoming usable.
  await Promise.all([
    container.openclawProcess.prepare(),
    container.openclawSyncService.ensureRuntimeModelPlugin(),
  ]);

  // Validate default model against available models before first sync
  await container.modelProviderService.ensureValidDefaultModel();

  // Ensure bundled skills are on disk and the skill ledger is up to date
  // BEFORE the first config push.  Without this, the compiled agent
  // allowlist may be missing newly-bundled skills, causing them to be
  // invisible to the running agent until a restart.
  container.skillhubService.bootstrap();

  // A crash after staging a restart-required config must not lose the update.
  // Apply it before the gateway starts, when no chat can be interrupted.
  await container.configSyncCoordinator?.recoverPendingBeforeGatewayStart();

  // Write config files BEFORE starting OpenClaw so it boots with the
  // correct configuration, avoiding a SIGUSR1 restart cycle on first connect.
  // Use syncAllImmediate() to bypass debounce — must complete before start().
  // This also seeds the push hash via noteConfigWritten(), so the onConnected
  // syncAll() sees no change and skips the redundant config.apply RPC.
  await container.openclawSyncService.syncAllImmediate();

  let stableResolved = false;
  const signalStable = (() => {
    let resolveStable: (() => void) | null = null;
    const stablePromise = new Promise<void>((resolve) => {
      resolveStable = resolve;
    });
    return {
      stablePromise,
      resolve: () => {
        if (stableResolved) {
          return;
        }
        stableResolved = true;
        resolveStable?.();
      },
    };
  })();

  // Enter settling mode until the managed runtime reaches a stable state.
  const settlingDone = container.openclawSyncService.beginSettling(
    signalStable.stablePromise,
  );

  container.openclawProcess.enableAutoRestart();
  container.openclawProcess.start();
  container.gatewayService.enableDisconnectedWriteTracking();
  container.channelFallbackService.start();

  // Start WS client — connects to OpenClaw gateway
  container.wsClient.connect();

  const disposeStableWatch = container.openclawProcess.onStable(() => {
    if (container.wsClient.isConnected()) {
      signalStable.resolve();
    }
  });

  void settlingDone.then(() => {
    void (async () => {
      // Refresh after local startup. This keeps cached models available for
      // the first request while making cloud availability eventually
      // consistent.
      await delay(POST_BOOT_CLOUD_REFRESH_DELAY_MS);
      await container.configStore
        .prepareDesktopCloudModelsForBootstrap()
        .catch(() => {});
      await container.modelProviderService.ensureValidDefaultModel();
      void container.openclawSyncService.syncAll().catch(() => {});
    })();
  });

  container.wsClient.onGatewayShutdown(({ restartExpectedMs }) => {
    if (restartExpectedMs !== null) {
      container.openclawProcess.noteControlledRestartExpected("ws-shutdown");
    }
  });

  // When WS handshake completes, push current config (skipped if unchanged)
  // and mark boot as complete so health loop treats future gateway-unreachable
  // as "unhealthy" instead of "starting".
  container.wsClient.onConnected(() => {
    container.runtimeState.bootPhase = "ready";
    // Force a re-push when writes landed after the process started but before
    // the WS handshake completed, or during a later gateway reconnect.
    const hasDisconnectedWrites = container.gatewayService.invalidateIfDirty();
    if (container.openclawProcess.isStable()) {
      signalStable.resolve();
    }
    if (hasDisconnectedWrites) {
      void container.openclawSyncService.syncAll().catch(() => {});
    }
  });

  const stopBackgroundLoops = container.startBackgroundLoops();
  return () => {
    disposeStableWatch();
    stopBackgroundLoops();
  };
}
