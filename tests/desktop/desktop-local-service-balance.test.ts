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
    clearActivation: vi.fn(async () => undefined),
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
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requests.push({ url, method: init?.method ?? "GET" });

        if (url === "https://cloud.example.com/api/auth/balance") {
          return Response.json({
            success: true,
            balance_cents: 5000,
            total_recharged: 10000,
          });
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return Response.json({ hard_limit_usd: 100 });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 9500 });
        }

        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 5000,
      total_recharged: 10000,
      upstream_total_cents: 10000,
      recharge_delta_cents: 0,
      recharge_reconcile_status: "matched",
    });
    expect(requests.map((request) => request.url)).toContain(
      "https://cloud.example.com/api/auth/balance",
    );
    expect(requests.map((request) => request.url)).toContain(
      "https://yunwu.example.com/v1/dashboard/billing/subscription",
    );
    expect(requests).not.toContainEqual({
      url: "https://cloud.example.com/api/auth/redeem-recharge",
      method: "POST",
    });
  });

  it("reports recharge drift without auto-redeeming when cloud total lags upstream quota", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requests.push({ url, method: init?.method ?? "GET" });

        if (url.endsWith("/api/auth/balance")) {
          return Response.json({
            success: true,
            balance_cents: 7400,
            total_recharged: 10000,
          });
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return Response.json({ hard_limit_usd: 123.45 });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 4945 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 7400,
      total_recharged: 10000,
      upstream_total_cents: 12345,
      recharge_delta_cents: 2345,
      recharge_reconcile_status: "cloud_behind",
    });
    expect(requests).not.toContainEqual({
      url: "https://cloud.example.com/api/auth/redeem-recharge",
      method: "POST",
    });
  });

  it("falls back to user billing when cloud balance API returns an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/balance")) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "fetch failed",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return Response.json({ hard_limit_usd: 1.23 });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 45 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { configStore, service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 78,
      upstream_total_cents: 123,
    });
    expect(configStore.clearActivation).not.toHaveBeenCalled();
  });

  it("retries transient Yunwu billing 5xx responses for idempotent balance reads", async () => {
    const subscriptionStatuses: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/balance")) {
          return Response.json({ success: false, error: "fetch failed" });
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          subscriptionStatuses.push(502);
          if (subscriptionStatuses.length === 1) {
            return new Response("Bad gateway", { status: 502 });
          }
          return Response.json({ hard_limit_usd: 3 });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 25 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 275,
      upstream_total_cents: 300,
    });
    expect(subscriptionStatuses).toHaveLength(2);
  });

  it("does not return a fabricated balance when billing fields are invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/balance")) {
          return Response.json({ success: false, error: "fetch failed" });
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return Response.json({ hard_limit_usd: "1.23" });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 45 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "fetch failed",
    });
  });

  it("keeps the original balance error when user billing also fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/balance")) {
          return new Response(
            JSON.stringify({ success: false, error: "fetch failed" }),
            { status: 200 },
          );
        }
        return new Response("Billing unavailable", { status: 503 });
      }),
    );

    const { service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "fetch failed",
    });
  });

  it("clears activation when the balance JWT has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("JWT expired", { status: 401 })),
    );

    const { configStore, service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "Not authenticated",
    });
    expect(configStore.clearActivation).toHaveBeenCalledTimes(1);
  });

  it("keeps the local session and uses billing fallback for an unclassified 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/balance")) {
          return Response.json(
            { error: "Temporary authorization gateway failure" },
            { status: 401 },
          );
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return Response.json({ hard_limit_usd: 2 });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 25 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { configStore, service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 175,
      upstream_total_cents: 200,
    });
    expect(configStore.clearActivation).not.toHaveBeenCalled();
  });

  it("clears activation for an authoritative session revocation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith("/api/auth/balance")) {
          return Response.json(
            {
              success: false,
              error: "账号已在其它设备登录，本设备已被强制下线",
              code: "SESSION_KICKED",
            },
            { status: 401 },
          );
        }
        return new Response("Billing unavailable", { status: 503 });
      }),
    );

    const { configStore, service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: false,
      error: "Not authenticated",
    });
    expect(configStore.clearActivation).toHaveBeenCalledTimes(1);
  });

  it("clears activation when the transactions JWT has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("JWT expired", { status: 401 })),
    );

    const { configStore, service } = createService();
    await expect(service.getTransactions(2, 20)).resolves.toEqual({
      success: false,
      transactions: [],
      total: 0,
      page: 2,
      page_size: 20,
      error: "Not authenticated",
    });
    expect(configStore.clearActivation).toHaveBeenCalledTimes(1);
  });

  it("surfaces usage-log authorization errors without hiding them as empty data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Temporary authorization gateway failure" },
          { status: 401 },
        ),
      ),
    );

    const { configStore, service } = createService();
    await expect(service.getUsageLogs(1, 10)).resolves.toEqual({
      success: false,
      logs: [],
      total: 0,
      page: 1,
      page_size: 10,
      error: "Temporary authorization gateway failure",
    });
    expect(configStore.clearActivation).not.toHaveBeenCalled();
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
