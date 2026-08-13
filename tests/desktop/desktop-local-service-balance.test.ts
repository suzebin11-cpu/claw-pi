import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLocalService } from "#controller/services/desktop-local-service.js";

function createService() {
  const configStore = {
    getActivationJwt: vi.fn(async () => "activation-jwt"),
    getActivationApiKey: vi.fn(async () => "user-api-key"),
    getActivationStatus: vi.fn(async () => ({
      activated: true,
      email: "user@example.com",
      activatedAt: "2026-08-01T00:00:00.000Z",
      codePrefix: null,
    })),
    setActivationState: vi.fn(async () => undefined),
    applyActivationCloudState: vi.fn(async () => undefined),
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

  it("uses the fixed child-token balance returned by the cloud API", async () => {
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
    });
    expect(requests.map((request) => request.url)).toContain(
      "https://cloud.example.com/api/auth/balance",
    );
    expect(requests.map((request) => request.url)).not.toContain(
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
    });
    expect(requests).not.toContainEqual({
      url: "https://cloud.example.com/api/auth/redeem-recharge",
      method: "POST",
    });
  });

  it("does not replace a cloud balance error with an account-level bill", async () => {
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
      ok: false,
      error: "fetch failed",
    });
    expect(configStore.clearActivation).not.toHaveBeenCalled();
  });

  it("does not query account-level billing when the fixed-token balance fails", async () => {
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
      ok: false,
      error: "fetch failed",
    });
    expect(subscriptionStatuses).toHaveLength(0);
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

  it("keeps the local session and surfaces an unclassified 401", async () => {
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
      ok: false,
      error: "Temporary authorization gateway failure",
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

  it("normalizes nested usage logs so details remain visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (
          input
            .toString()
            .endsWith("/api/auth/usage-logs?page=2&page_size=10")
        ) {
          return Response.json({
            success: true,
            data: {
              usage_logs: [
                {
                  logId: "42",
                  model: "gpt-5.5",
                  costCents: "13",
                  input_tokens: "1200",
                  output_tokens: 345,
                  createdAt: "2026-08-12T08:00:00.000Z",
                },
              ],
              total_count: "11",
              pageSize: "10",
            },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    await expect(service.getUsageLogs(2, 10)).resolves.toEqual({
      success: true,
      logs: [
        {
          id: 42,
          model_name: "gpt-5.5",
          cost_cents: 13,
          prompt_tokens: 1200,
          completion_tokens: 345,
          created_at: "2026-08-12T08:00:00.000Z",
        },
      ],
      total: 11,
      page: 2,
      page_size: 10,
    });
  });

  it("preserves sub-cent costs in detailed usage logs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().includes("/api/auth/usage-logs?")) {
          return Response.json({
            success: true,
            logs: [
              {
                id: 11672754,
                model_name: "gpt-5.5",
                cost_cents: 0.0042,
                prompt_tokens: 7,
                completion_tokens: 23,
                created_at: "2026-08-13T05:26:06.000Z",
              },
            ],
            total: 1,
            page: 1,
            page_size: 10,
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    await expect(createService().service.getUsageLogs(1, 10)).resolves.toEqual({
      success: true,
      logs: [
        {
          id: 11672754,
          model_name: "gpt-5.5",
          cost_cents: 0.0042,
          prompt_tokens: 7,
          completion_tokens: 23,
          created_at: "2026-08-13T05:26:06.000Z",
        },
      ],
      total: 1,
      page: 1,
      page_size: 10,
    });
  });

  it("refreshes a migrated desktop's cached upstream key from its JWT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/user-activate")) {
          return Response.json({
            success: true,
            api_key: "fixed-child-token",
            api_base_url: "https://api.openlux.ai",
            models: [],
          });
        }
        if (url.endsWith("/api/auth/balance")) {
          return Response.json({ success: true, balance_cents: 2342 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { configStore, service } = createService();
    await expect(service.getBalance()).resolves.toEqual({
      ok: true,
      balance_cents: 2342,
    });
    expect(configStore.setActivationState).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "fixed-child-token" }),
    );
    expect(configStore.applyActivationCloudState).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "fixed-child-token",
        linkUrl: "https://api.openlux.ai",
      }),
    );
  });

  it("does not fabricate an aggregate usage row when detailed logs fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith("/api/auth/usage-logs?page=1&page_size=10")) {
          return Response.json({ success: false, error: "fetch failed" });
        }
        if (url.endsWith("/v1/dashboard/billing/subscription")) {
          return Response.json({ hard_limit_usd: 206.846928 });
        }
        if (url.includes("/v1/dashboard/billing/usage?")) {
          return Response.json({ total_usage: 20505.8612 });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { service } = createService();
    const result = await service.getUsageLogs(1, 10);

    expect(result).toEqual({
      success: false,
      logs: [],
      total: 0,
      page: 1,
      page_size: 10,
      error: "fetch failed",
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
