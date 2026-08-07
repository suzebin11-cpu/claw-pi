import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "@nexu/shared";
import { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";

describe("OpenClawGatewayService", () => {
  const makeConfig = (models: string[] = []) =>
    ({
      gateway: {
        port: 18789,
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: "test-token" },
      },
      models: {
        providers: {
          link: { models: models.map((id) => ({ id, name: id })) },
        },
      },
      agents: {
        defaults: { model: { primary: "link/gpt-5.5" } },
        list: [],
      },
    }) as OpenClawConfig;

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

  it("uses Gateway planning while preserving the local revision", async () => {
    const service = new OpenClawGatewayService({
      isConnected: () => true,
      request: async () => ({
        changedPaths: ["stale"],
        hotReloadPaths: ["models.providers.link.models"],
        restartRequiredPaths: [],
        noopPaths: [],
        restartRequired: false,
        configRevision: "stale-revision",
      }),
    } as never);

    const plan = await service.planConfigChange(
      makeConfig(["old"]),
      makeConfig(["new"]),
    );

    expect(plan.changedPaths).toEqual(["models.providers.link.models"]);
    expect(plan.hotReloadPaths).toEqual(["models.providers.link.models"]);
    expect(plan.restartRequired).toBe(false);
    expect(plan.configRevision).not.toBe("stale-revision");
  });

  it("fails unclassified Gateway paths safe to restart", async () => {
    const service = new OpenClawGatewayService({
      isConnected: () => true,
      request: async () => ({
        hotReloadPaths: [],
        restartRequiredPaths: [],
        noopPaths: [],
      }),
    } as never);

    const plan = await service.planConfigChange(
      makeConfig(["old"]),
      makeConfig(["new"]),
    );

    expect(plan.restartRequiredPaths).toEqual(["models.providers.link.models"]);
    expect(plan.restartRequired).toBe(true);
  });
});
