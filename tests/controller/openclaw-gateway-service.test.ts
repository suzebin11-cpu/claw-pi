import type { OpenClawConfig } from "@nexu/shared";
import { describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeState } from "#controller/runtime/state";
import { OpenClawGatewayService } from "#controller/services/openclaw-gateway-service";

function createRuntimeState(): ControllerRuntimeState {
  return {
    bootPhase: "booting",
    status: "starting",
    configSyncStatus: "active",
    skillsSyncStatus: "active",
    templatesSyncStatus: "active",
    gatewayStatus: "starting",
    lastConfigSyncAt: null,
    lastSkillsSyncAt: null,
    lastTemplatesSyncAt: null,
    lastGatewayProbeAt: null,
    lastGatewayError: null,
  };
}

function createConfig(name: string): OpenClawConfig {
  return {
    $schema: "https://api.clawpi.app:9443/config.json",
    schemaVersion: 1,
    app: {},
    bots: [],
    runtime: {
      gateway: {
        port: 18789,
        bind: "loopback",
        authMode: "none",
      },
      defaultModelId: "link/gpt-5.4",
    },
    models: {
      providers: {
        link: {
          api: "openai-completions",
          baseUrl: "https://yunwu.ai/v1",
          apiKey: "test-key",
          models: [{ id: "gpt-5.4", name }],
        },
      },
    },
    channels: {},
    agents: {
      defaults: {
        model: "link/gpt-5.4",
      },
      items: {},
    },
  } as unknown as OpenClawConfig;
}

describe("OpenClawGatewayService disconnected write tracking", () => {
  it("does not invalidate on reconnect unless a tracked disconnected write happened", () => {
    const wsClient = {
      isConnected: vi.fn(() => false),
    };
    const service = new OpenClawGatewayService(
      wsClient as never,
      createRuntimeState(),
    );

    service.noteConfigWritten(createConfig("initial"));
    expect(service.invalidateIfDirty()).toBe(false);

    service.enableDisconnectedWriteTracking();
    expect(service.invalidateIfDirty()).toBe(false);

    service.noteConfigWritten(createConfig("offline-write"));
    expect(service.invalidateIfDirty()).toBe(true);
    expect(service.invalidateIfDirty()).toBe(false);
  });

  it("ignores connected writes after tracking is enabled", () => {
    const wsClient = {
      isConnected: vi.fn(() => true),
    };
    const service = new OpenClawGatewayService(
      wsClient as never,
      createRuntimeState(),
    );

    service.enableDisconnectedWriteTracking();
    service.noteConfigWritten(createConfig("connected-write"));

    expect(service.invalidateIfDirty()).toBe(false);
  });
});
