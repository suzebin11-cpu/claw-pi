import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLocalService } from "#controller/services/desktop-local-service.js";

function createService() {
  const configStore = {
    getDesktopCloudStatus: vi.fn(async () => ({
      cloudUrl: "https://cloud.example.com",
      linkUrl: "https://link.example.com",
    })),
  };

  return new DesktopLocalService(
    configStore as never,
    {} as never,
    {} as never,
  );
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
      createService().loginWithCredentials({
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
        createService().loginWithCredentials({
          email: "user@example.com",
          password: "wrong",
        }),
      ).resolves.toEqual({
        ok: false,
        error: "Invalid email or password",
      });
    },
  );
});
