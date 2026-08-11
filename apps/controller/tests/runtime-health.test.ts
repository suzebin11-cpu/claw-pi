import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/proxy-fetch.js", () => ({
  proxyFetch: proxyFetchMock,
}));

import { RuntimeHealth } from "../src/runtime/runtime-health.js";

function createEnv(gatewayProbeEnabled = true): ControllerEnv {
  return {
    gatewayProbeEnabled,
    openclawGatewayPort: 18789,
  } as ControllerEnv;
}

describe("RuntimeHealth", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it("uses OpenClaw's liveness endpoint", async () => {
    proxyFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(new RuntimeHealth(createEnv()).probe()).resolves.toEqual({
      ok: true,
      status: 200,
    });
    expect(proxyFetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/healthz",
      { timeoutMs: 3_000 },
    );
  });

  it("reports an unreachable gateway as failed", async () => {
    proxyFetchMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(new RuntimeHealth(createEnv()).probe()).resolves.toEqual({
      ok: false,
      status: null,
    });
  });

  it("skips the network request only when explicitly disabled", async () => {
    await expect(
      new RuntimeHealth(createEnv(false)).probe(),
    ).resolves.toEqual({
      ok: true,
      status: null,
    });
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });
});
