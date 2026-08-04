import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureNetworkDefaults,
  mergeNoProxyEntries,
  proxyFetch,
  readProxyFetchEnv,
  redactProxyUrl,
  shouldBypassProxy,
} from "../src/lib/proxy-fetch.js";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
];

function resetProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
    delete process.env[key.toLowerCase()];
  }
}

describe("proxyFetch", () => {
  beforeEach(() => {
    resetProxyEnv();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetProxyEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("merges and deduplicates loopback NO_PROXY entries", () => {
    expect(mergeNoProxyEntries("example.com,localhost,127.0.0.1")).toEqual([
      "example.com",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
  });

  it("normalizes ALL_PROXY into HTTP and HTTPS proxy config", () => {
    process.env.ALL_PROXY = "http://proxy.example.com:8080";
    process.env.no_proxy = "example.internal";

    expect(readProxyFetchEnv()).toEqual({
      httpProxy: "http://proxy.example.com:8080",
      httpsProxy: "http://proxy.example.com:8080",
      allProxy: "http://proxy.example.com:8080",
      noProxy: ["example.internal", "localhost", "127.0.0.1", "::1"],
    });
  });

  it("bypasses loopback and configured NO_PROXY hosts", () => {
    expect(shouldBypassProxy("http://127.0.0.1:3000")).toBe(true);
    expect(
      shouldBypassProxy("https://api.example.internal", [".example.internal"]),
    ).toBe(true);
    expect(
      shouldBypassProxy("https://api.clawpi.app:9443", [".example.internal"]),
    ).toBe(false);
  });

  it("times out hanging requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };

          if (signal) {
            if (signal.aborted) {
              abort();
              return;
            }
            signal.addEventListener("abort", abort, { once: true });
          }
        });
      }),
    );

    await expect(
      proxyFetch("https://example.com/resource", { timeoutMs: 5 }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Request to https://example.com timed out after 5ms",
    });
  });

  it("redacts proxy credentials from thrown errors", async () => {
    process.env.HTTP_PROXY = "http://user:pass@proxy.example.com:8080";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "connect ECONNREFUSED http://user:pass@proxy.example.com:8080",
        );
      }),
    );

    await expect(proxyFetch("https://example.com")).rejects.toMatchObject({
      message: "connect ECONNREFUSED http://***:***@proxy.example.com:8080/",
    });
    await proxyFetch("https://example.com").catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect("cause" in (error as Error)).toBe(false);
    });
    expect(redactProxyUrl(process.env.HTTP_PROXY ?? null)).toBe(
      "http://***:***@proxy.example.com:8080/",
    );
  });

  it("enables env proxy fallback when proxy env is configured", async () => {
    process.env.HTTP_PROXY = "http://proxy.example.com:8080";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
    );

    await proxyFetch("https://example.com");

    expect(process.env.NODE_USE_ENV_PROXY).toBe("1");
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  });

  it("applies IPv4-first and happy-eyeballs connection defaults", () => {
    ensureNetworkDefaults();

    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(500);
  });

  it("retries an idempotent GET once on a transient connect timeout", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("fetch failed"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyFetch("https://example.com");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-idempotent requests", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      proxyFetch("https://example.com", { method: "POST", body: "{}" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry after the deadline already expired", async () => {
    // Without the deadline check the retry fires into an aborted signal and
    // masks the real timeout reason.
    const fetchMock = vi.fn(
      (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("fetch failed"), {
                  code: "UND_ERR_CONNECT_TIMEOUT",
                }),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      proxyFetch("https://example.com", { timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies a default deadline so no request can hang forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    );

    vi.useFakeTimers();
    try {
      const pending = proxyFetch("https://example.com").catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(30_001);

      expect(await pending).toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours timeoutMs: null for streamed responses", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        // Opting out must leave the request without any abort deadline.
        expect(init?.signal).toBeUndefined();
        return new Response("stream");
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyFetch("https://example.com", {
      timeoutMs: null,
    });

    expect(response.status).toBe(200);
  });
});
