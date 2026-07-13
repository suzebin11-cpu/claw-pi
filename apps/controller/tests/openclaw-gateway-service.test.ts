import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "@nexu/shared";
import { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";

describe("OpenClawGatewayService", () => {
  it("invalidates the cached config hash after a disconnected write", async () => {
    let connected = false;
    const service = new OpenClawGatewayService({
      isConnected: () => connected,
    } as never);
    const config = {
      gateway: {
        port: 18789,
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: "test-token" },
      },
      agents: {
        defaults: {
          model: { primary: "link/gpt-5.5" },
        },
        list: [],
      },
    } as OpenClawConfig;

    service.preSeedConfigHash(config);
    expect(await service.shouldPushConfig(config)).toBe(false);

    service.enableDisconnectedWriteTracking();
    service.noteConfigWritten(config);
    connected = true;

    expect(service.invalidateIfDirty()).toBe(true);
    expect(await service.shouldPushConfig(config)).toBe(true);
  });
});
