import { describe, expect, it, vi } from "vitest";
import { ProxyManager } from "../../apps/desktop/main/services/proxy-manager";
import { readProxyPolicy } from "../../apps/desktop/shared/proxy-config";

describe("ProxyManager", () => {
  it("applies fixed proxy config and closes connections", async () => {
    const setProxy = vi.fn(async () => undefined);
    const closeAllConnections = vi.fn(async () => undefined);
    const resolveProxy = vi.fn(async () => "DIRECT");
    const manager = new ProxyManager({
      setProxy,
      closeAllConnections,
      resolveProxy,
    });

    await manager.applyPolicy(
      readProxyPolicy({ HTTP_PROXY: "http://proxy.example.com:8080" }),
    );

    expect(setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: "http=http://proxy.example.com:8080",
      proxyBypassRules: "<local>;localhost;127.0.0.1;::1",
    });
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it("collects redacted diagnostics and resolveProxy results", async () => {
    const manager = new ProxyManager({
      setProxy: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      resolveProxy: vi.fn(async (url: string) =>
        url.includes("127.0.0.1") ? "DIRECT" : "PROXY corp.proxy:8080",
      ),
    });

    const snapshot = await manager.collectDiagnostics(
      readProxyPolicy({
        HTTPS_PROXY: "http://user:pass@proxy.example.com:8443",
      }),
      [
        { label: "controller", url: "http://127.0.0.1:50800" },
        { label: "external", url: "https://api.clawpi.app:9443" },
      ],
    );

    expect(snapshot.source).toBe("env");
    expect(snapshot.env.httpsProxyRedacted).toBe(
      "http://***:***@proxy.example.com:8443/",
    );
    expect(snapshot.electron.proxyRulesRedacted).toBe(
      "https=http://***:***@proxy.example.com:8443/",
    );
    expect(snapshot.resolutions).toEqual([
      {
        label: "controller",
        url: "http://127.0.0.1:50800",
        result: "DIRECT",
      },
      {
        label: "external",
        url: "https://api.clawpi.app:9443",
        result: "PROXY corp.proxy:8080",
      },
    ]);
  });

  it("uses system mode when env proxies are absent", async () => {
    const setProxy = vi.fn(async () => undefined);
    const manager = new ProxyManager({
      setProxy,
      closeAllConnections: vi.fn(async () => undefined),
      resolveProxy: vi.fn(async () => "DIRECT"),
    });

    await manager.applyPolicy(readProxyPolicy({}));

    expect(setProxy).toHaveBeenCalledWith({ mode: "system" });
  });

  it("supports explicit direct mode", async () => {
    const setProxy = vi.fn(async () => undefined);
    const manager = new ProxyManager({
      setProxy,
      closeAllConnections: vi.fn(async () => undefined),
      resolveProxy: vi.fn(async () => "DIRECT"),
    });

    await manager.applyPolicy(readProxyPolicy({}, { defaultSource: "direct" }));

    expect(setProxy).toHaveBeenCalledWith({ mode: "direct" });
  });

  describe("resolveSystemProxy", () => {
    function createManager(resolveProxy: (url: string) => Promise<string>) {
      return new ProxyManager({
        setProxy: vi.fn(async () => undefined),
        closeAllConnections: vi.fn(async () => undefined),
        resolveProxy: vi.fn(resolveProxy),
      });
    }

    it("returns the proxy Chromium resolved for external traffic", async () => {
      const resolveProxy = vi.fn(async () => "PROXY corp.proxy:8080");
      const manager = createManager(resolveProxy);

      expect(await manager.resolveSystemProxy()).toEqual({
        url: "http://corp.proxy:8080",
      });
      expect(resolveProxy).toHaveBeenCalledWith(
        "https://api.openlux.ai/v1/models",
      );
    });

    it("returns null on a direct network", async () => {
      const manager = createManager(async () => "DIRECT");

      expect(await manager.resolveSystemProxy()).toBeNull();
    });

    it("returns null when resolution rejects", async () => {
      const manager = createManager(async () => {
        throw new Error("resolver unavailable");
      });

      expect(await manager.resolveSystemProxy()).toBeNull();
    });

    it("gives up rather than letting a hung PAC lookup block startup", async () => {
      vi.useFakeTimers();
      try {
        const manager = createManager(() => new Promise<string>(() => {}));
        const pending = manager.resolveSystemProxy();

        await vi.advanceTimersByTimeAsync(3_100);

        expect(await pending).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
