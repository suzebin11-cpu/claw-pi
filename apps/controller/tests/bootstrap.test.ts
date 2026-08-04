import { describe, expect, it, vi } from "vitest";
import { bootstrapController } from "../src/app/bootstrap.js";
import type { ControllerContainer } from "../src/app/container.js";

function createContainer(opts?: { hasDisconnectedWrites?: boolean }) {
  let onConnected: (() => void) | null = null;
  let onStable: (() => void) | null = null;

  const container = {
    configStore: {
      shouldSkipCloudHydrationForBootstrap: vi.fn(async () => false),
      prepareDesktopCloudModelsForBootstrap: vi.fn(async () => {}),
    },
    openclawProcess: {
      prepare: vi.fn(async () => {}),
      enableAutoRestart: vi.fn(),
      start: vi.fn(),
      isStable: vi.fn(() => true),
      onStable: vi.fn((cb: () => void) => {
        onStable = cb;
        return vi.fn();
      }),
      noteControlledRestartExpected: vi.fn(),
    },
    openclawSyncService: {
      ensureRuntimeModelPlugin: vi.fn(async () => {}),
      syncAllImmediate: vi.fn(async () => ({ configPushed: false })),
      beginSettling: vi.fn(() => Promise.resolve()),
      syncAll: vi.fn(async () => ({ configPushed: false })),
    },
    modelProviderService: {
      ensureValidDefaultModel: vi.fn(async () => {}),
    },
    skillhubService: {
      bootstrap: vi.fn(),
    },
    gatewayService: {
      enableDisconnectedWriteTracking: vi.fn(),
      invalidateIfDirty: vi.fn(() => opts?.hasDisconnectedWrites ?? false),
    },
    channelFallbackService: {
      start: vi.fn(),
    },
    wsClient: {
      connect: vi.fn(),
      isConnected: vi.fn(() => true),
      onGatewayShutdown: vi.fn(),
      onConnected: vi.fn((cb: () => void) => {
        onConnected = cb;
      }),
    },
    runtimeState: {
      bootPhase: "booting",
    },
    startBackgroundLoops: vi.fn(() => vi.fn()),
  } as unknown as ControllerContainer;

  return {
    container,
    emitConnected: () => onConnected?.(),
    emitStable: () => onStable?.(),
  };
}

describe("bootstrapController", () => {
  it("does not sync OpenClaw again on first connect when no disconnected writes landed", async () => {
    const { container, emitConnected } = createContainer();

    await bootstrapController(container);
    emitConnected();

    expect(container.gatewayService.invalidateIfDirty).toHaveBeenCalledTimes(1);
    expect(container.openclawSyncService.syncAll).not.toHaveBeenCalled();
  });

  it("syncs OpenClaw on connect when disconnected writes were tracked", async () => {
    const { container, emitConnected } = createContainer({
      hasDisconnectedWrites: true,
    });

    await bootstrapController(container);
    emitConnected();

    expect(container.openclawSyncService.syncAll).toHaveBeenCalledTimes(1);
  });

  it("does not block bootstrap on cloud model hydration", async () => {
    const { container } = createContainer();
    const hydration = vi.fn(
      () => new Promise<void>(() => {}),
    );
    container.configStore.prepareDesktopCloudModelsForBootstrap = hydration;

    await bootstrapController(container);

    expect(container.openclawProcess.start).toHaveBeenCalledTimes(1);
    expect(container.wsClient.connect).toHaveBeenCalledTimes(1);
    expect(hydration).not.toHaveBeenCalled();
  });
});
