import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLocalService } from "#controller/services/desktop-local-service.js";

function createService() {
  const configStore = {
    getActivationJwt: vi.fn(async () => "activation-jwt"),
    getActivationApiKey: vi.fn(async () => "user-api-key"),
    getDesktopCloudStatus: vi.fn(async () => ({
      cloudUrl: "https://cloud.example.com",
      linkUrl: "https://yunwu.example.com",
    })),
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

describe("DesktopLocalService balance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns balance successfully when cloud API succeeds", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        requestedUrls.push(url);

        if (url === "https://cloud.example.com/api/auth/balance") {
          return Response.json({
            success: true,
            balance_cents: 5000,
            total_recharged: 10000,
          });
        }

        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 5000,
      total_recharged: 10000,
    });
    expect(requestedUrls).toContain("https://cloud.example.com/api/auth/balance");
  });

  it("returns error when cloud balance API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith("/api/auth/balance")) {
          return new Response(
            JSON.stringify({
              success: false,
              error:
                "Yunwu API error: You have used invalid tokens multiple times",
            }),
            { status: 502 },
          );
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "Yunwu API error: You have used invalid tokens multiple times",
    });
  });

  it("returns normalized upstream error when cloud API returns error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith("/api/auth/balance")) {
          return new Response(
            JSON.stringify({
              error: JSON.stringify({
                success: false,
                error: "Yunwu API error: invalid tokens",
              }),
            }),
            { status: 200 },
          );
        }
        return new Response("Unauthorized", { status: 401 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "Yunwu API error: invalid tokens",
    });
  });

  it("returns server unreachable when network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network error");
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "Server unreachable",
    });
  });
});
