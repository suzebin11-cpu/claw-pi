import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawProcessManager } from "../src/runtime/openclaw-process.js";
import { DesktopLocalService } from "../src/services/desktop-local-service.js";
import type { ModelProviderService } from "../src/services/model-provider-service.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";

function createService(response: Response) {
  const clearActivation = vi.fn(async () => {});
  const configStore = {
    getActivationJwt: vi.fn(async () => "jwt-token"),
    getDesktopCloudStatus: vi.fn(async () => ({
      cloudUrl: "https://cloud.example",
    })),
    clearActivation,
  } as unknown as NexuConfigStore;

  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);

  return {
    service: new DesktopLocalService(
      configStore,
      {} as ModelProviderService,
      {} as OpenClawProcessManager,
    ),
    clearActivation,
    fetchMock,
  };
}

describe("DesktopLocalService billing auth errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears activation and normalizes expired balance tokens", async () => {
    const { service, clearActivation } = createService(
      new Response(JSON.stringify({ error: "token 已过期" }), {
        status: 401,
      }),
    );

    await expect(service.getBalance()).resolves.toMatchObject({
      ok: false,
      error: "登录状态已过期，请重新登录",
    });
    expect(clearActivation).toHaveBeenCalledTimes(1);
  });

  it("clears activation and normalizes expired Alipay order tokens", async () => {
    const { service, clearActivation, fetchMock } = createService(
      new Response(JSON.stringify({ error: "jwt expired" }), {
        status: 200,
      }),
    );

    await expect(service.createAlipayOrder(1000)).resolves.toMatchObject({
      ok: false,
      error: "登录状态已过期，请重新登录",
    });
    expect(clearActivation).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
