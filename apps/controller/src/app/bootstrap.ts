import type { ControllerContainer } from "./container.js";

export async function bootstrapController(
  container: ControllerContainer,
): Promise<() => void> {
  const skipCloudHydration =
    await container.configStore.shouldSkipCloudHydrationForBootstrap();

  // Run independent prep tasks in parallel to shave off startup time.
  // All three are independent: process cleanup, plugin files, cloud model fetch.
  await Promise.all([
    container.openclawProcess.prepare(),
    container.openclawSyncService.ensureRuntimeModelPlugin(),
    skipCloudHydration
      ? Promise.resolve()
      : container.configStore
          .prepareDesktopCloudModelsForBootstrap()
          .catch(() => {}),
  ]);

  // Validate default model against available models before first sync
  await container.modelProviderService.ensureValidDefaultModel();

  // Ensure bundled skills are on disk and the skill ledger is up to date
  // BEFORE the first config push.  Without this, the compiled agent
  // allowlist may be missing newly-bundled skills, causing them to be
  // invisible to the running agent until a restart.
  container.skillhubService.bootstrap();

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
  container.channelFallbackService.start();

  // Start WS client — connects to OpenClaw gateway
  container.wsClient.connect();

  const disposeStableWatch = container.openclawProcess.onStable(() => {
    if (container.wsClient.isConnected()) {
      signalStable.resolve();
    }
  });

  void settlingDone.then(() => {
    if (!skipCloudHydration) {
      return;
    }
    void (async () => {
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
  let isFirstWsConnect = true;
  container.wsClient.onConnected(() => {
    container.runtimeState.bootPhase = "ready";
    if (isFirstWsConnect) {
      container.gatewayService.enableDisconnectedWriteTracking();
    } else {
      // Gateway restarted — only force a re-push when writes actually landed
      // while the WS was disconnected.
      container.gatewayService.invalidateIfDirty();
    }
    isFirstWsConnect = false;
    if (container.openclawProcess.isStable()) {
      signalStable.resolve();
    }
    void container.openclawSyncService.syncAll().catch(() => {});
  });

  const stopBackgroundLoops = container.startBackgroundLoops();
  return () => {
    disposeStableWatch();
    stopBackgroundLoops();
  };
}
