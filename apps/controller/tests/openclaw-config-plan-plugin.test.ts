import { describe, expect, it } from "vitest";
// The runtime plugin is intentionally plain ESM because OpenClaw loads this
// source directly after it is bundled into the packaged runtime.
// @ts-expect-error The source plugin has no standalone declaration file.
import runtimeModelPlugin from "../static/runtime-plugins/nexu-runtime-model/index.js";

type PlanResponse = {
  changedPaths: string[];
  hotReloadPaths: string[];
  restartRequiredPaths: string[];
  restartRequired: boolean;
  configRevision: string;
};

describe("nexu.config.plan runtime RPC", () => {
  function plan(changedPaths: string[]): PlanResponse {
    let handler:
      | ((context: {
          params: unknown;
          respond: (ok: boolean, payload: PlanResponse) => void;
        }) => void)
      | undefined;

    runtimeModelPlugin.register({
      registerGatewayMethod(name: string, registeredHandler: typeof handler) {
        if (name === "nexu.config.plan") handler = registeredHandler;
      },
      on() {},
    });

    let response: PlanResponse | undefined;
    handler?.({
      params: { changedPaths, configRevision: "revision-1" },
      respond(ok, payload) {
        expect(ok).toBe(true);
        response = payload;
      },
    });
    if (!response) throw new Error("nexu.config.plan did not respond");
    return response;
  }

  it("classifies model catalog changes as hot reload", () => {
    const result = plan(["models.providers.link.models"]);

    expect(result).toMatchObject({
      hotReloadPaths: ["models.providers.link.models"],
      restartRequiredPaths: [],
      restartRequired: false,
      configRevision: "revision-1",
    });
  });

  it("classifies plugin entry changes as restart required", () => {
    const result = plan(["plugins.entries.xai.enabled"]);

    expect(result).toMatchObject({
      hotReloadPaths: [],
      restartRequiredPaths: ["plugins.entries.xai.enabled"],
      restartRequired: true,
    });
  });

  it("conservatively restarts unknown paths", () => {
    const result = plan(["future.unrecognized.setting"]);

    expect(result.restartRequiredPaths).toEqual([
      "future.unrecognized.setting",
    ]);
    expect(result.restartRequired).toBe(true);
  });
});
