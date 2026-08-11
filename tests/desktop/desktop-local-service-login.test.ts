import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLocalService } from "#controller/services/desktop-local-service.js";

function createService() {
  const configStore = {
    getDesktopCloudStatus: vi.fn(async () => ({
      cloudUrl: "https://cloud.example.com",
      linkUrl: "https://link.example.com",
    })),
    getOrCreateActivationDeviceId: vi.fn(async () => "device-123"),
    getActivationStatus: vi.fn(async () => ({
      activated: false,
      activatedAt: null,
      codePrefix: null,
    })),
    setActivationState: vi.fn(async () => undefined),
    applyActivationCloudState: vi.fn(async () => undefined),
  };

  return {
    configStore,
    service: new DesktopLocalService(
      configStore as never,
      {} as never,
      {} as never,
    ),
  };
}

function networkError(code: string) {
  return Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });
}

describe("DesktopLocalService credential login errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["ENOTFOUND", "DNS lookup failed"],
    ["CERT_HAS_EXPIRED", "TLS certificate validation failed"],
    ["UND_ERR_CONNECT_TIMEOUT", "Connection timed out"],
  ])("distinguishes %s transport failures", async (code, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw networkError(code);
      }),
    );

    await expect(
      createService().service.loginWithCredentials({
        email: "user@example.com",
        password: "secret",
      }),
    ).resolves.toEqual({ ok: false, error: expected });
  });

  it.each([400, 401, 403])(
    "identifies HTTP %s as a credential rejection",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ error: "upstream auth detail" }, { status }),
        ),
      );

      await expect(
        createService().service.loginWithCredentials({
          email: "user@example.com",
          password: "wrong",
        }),
      ).resolves.toEqual({
        ok: false,
        error: "Invalid email or password",
      });
    },
  );

  it("coalesces concurrent login submissions and sends the stable device id", async () => {
    let resolveLogin: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { configStore, service } = createService();
    const input = { email: "user@example.com", password: "secret" };
    const first = service.loginWithCredentials(input);
    const second = service.loginWithCredentials(input);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveLogin?.(
      Response.json({
        jwt: "latest-jwt",
        api_key: "api-key",
        api_base_url: "https://link.example.com",
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, email: input.email },
      { ok: true, email: input.email },
    ]);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      device_id: "device-123",
      deviceId: "device-123",
    });
    expect(configStore.setActivationState).toHaveBeenCalledTimes(1);
  });
});
