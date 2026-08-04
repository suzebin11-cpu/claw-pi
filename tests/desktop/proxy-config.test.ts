import { describe, expect, it } from "vitest";
import {
  buildChildProcessProxyEnv,
  buildElectronProxyConfig,
  mergeNoProxyEntries,
  parseResolvedProxy,
  readProxyPolicy,
  redactProxyUrl,
  withResolvedSystemProxy,
} from "../../apps/desktop/shared/proxy-config";

describe("proxy-config", () => {
  it("prefers uppercase proxy env vars and normalizes no_proxy", () => {
    const policy = readProxyPolicy({
      HTTP_PROXY: "http://upper.example:8080",
      http_proxy: "http://lower.example:8080",
      no_proxy: "example.com,localhost",
    });

    expect(policy.source).toBe("env");
    expect(policy.env.httpProxy).toBe("http://upper.example:8080");
    expect(policy.bypass).toEqual([
      "example.com",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
  });

  it("falls back to system mode when no proxy env is present", () => {
    const policy = readProxyPolicy({});

    expect(policy.source).toBe("system");
    expect(policy.bypass).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("can be forced to direct mode", () => {
    const policy = readProxyPolicy({}, { defaultSource: "direct" });

    expect(policy.source).toBe("direct");
  });

  it("redacts proxy credentials safely", () => {
    expect(
      redactProxyUrl(
        "http://user:pass@proxy.example.com:8080?token=secret#frag",
      ),
    ).toBe("http://***:***@proxy.example.com:8080/");
    expect(redactProxyUrl("not a url")).toBe("***");
  });

  it("deduplicates mandatory no_proxy entries", () => {
    expect(mergeNoProxyEntries("localhost,127.0.0.1,localhost")).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
  });

  it("builds child-process env with canonical uppercase keys", () => {
    const policy = readProxyPolicy({
      HTTPS_PROXY: "http://proxy.example.com:8443",
    });

    expect(buildChildProcessProxyEnv(policy)).toEqual({
      HTTPS_PROXY: "http://proxy.example.com:8443",
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("omits proxy vars for a system policy that was never resolved", () => {
    // Regression guard: this is the state that made sidecars connect DIRECT on
    // proxy-only Windows networks and fail with UND_ERR_CONNECT_TIMEOUT.
    const policy = readProxyPolicy({});

    expect(policy.source).toBe("system");
    expect(buildChildProcessProxyEnv(policy)).toEqual({
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  describe("parseResolvedProxy", () => {
    it("parses a PAC-style PROXY entry", () => {
      expect(parseResolvedProxy("PROXY proxy.corp:8080")).toEqual({
        url: "http://proxy.corp:8080",
      });
    });

    it("returns null for a direct connection", () => {
      expect(parseResolvedProxy("DIRECT")).toBeNull();
    });

    it("skips DIRECT and picks the first usable proxy in the list", () => {
      expect(parseResolvedProxy("DIRECT; PROXY proxy.corp:3128")).toEqual({
        url: "http://proxy.corp:3128",
      });
    });

    it("maps HTTPS entries to an https proxy origin", () => {
      expect(parseResolvedProxy("HTTPS secure.corp:443")).toEqual({
        url: "https://secure.corp",
      });
    });

    it("ignores SOCKS proxies that Node fetch cannot use", () => {
      expect(parseResolvedProxy("SOCKS5 socks.corp:1080")).toBeNull();
    });

    it("falls back to a later http proxy when SOCKS comes first", () => {
      expect(
        parseResolvedProxy("SOCKS5 socks.corp:1080; PROXY proxy.corp:8080"),
      ).toEqual({ url: "http://proxy.corp:8080" });
    });

    it("returns null for empty, malformed, or non-string input", () => {
      expect(parseResolvedProxy("")).toBeNull();
      expect(parseResolvedProxy(null)).toBeNull();
      expect(parseResolvedProxy(undefined)).toBeNull();
      expect(parseResolvedProxy("PROXY")).toBeNull();
      expect(parseResolvedProxy("PROXY :::::")).toBeNull();
    });
  });

  describe("withResolvedSystemProxy", () => {
    it("injects the resolved proxy so child processes receive it", () => {
      const policy = withResolvedSystemProxy(readProxyPolicy({}), {
        url: "http://proxy.corp:8080",
      });

      expect(buildChildProcessProxyEnv(policy)).toEqual({
        HTTP_PROXY: "http://proxy.corp:8080",
        HTTPS_PROXY: "http://proxy.corp:8080",
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "localhost,127.0.0.1,::1",
      });
    });

    it("never overrides an explicit env-configured proxy", () => {
      const explicit = readProxyPolicy({
        HTTPS_PROXY: "http://user-set.example:8443",
      });

      expect(
        withResolvedSystemProxy(explicit, { url: "http://resolved.corp:8080" }),
      ).toBe(explicit);
    });

    it("leaves the policy untouched on a direct network", () => {
      const policy = readProxyPolicy({});

      expect(withResolvedSystemProxy(policy, null)).toBe(policy);
    });

    it("redacts credentials in the resolved diagnostics", () => {
      const policy = withResolvedSystemProxy(readProxyPolicy({}), {
        url: "http://user:pass@proxy.corp:8080",
      });

      expect(policy.diagnostics.httpProxyRedacted).not.toContain("pass");
    });
  });

  it("builds fixed Electron proxy config with mandatory local bypass", () => {
    const policy = readProxyPolicy({
      HTTP_PROXY: "http://proxy.example.com:8080",
      NO_PROXY: "example.com",
    });

    expect(buildElectronProxyConfig(policy)).toEqual({
      mode: "fixed_servers",
      proxyRules: "http=http://proxy.example.com:8080",
      proxyBypassRules: "<local>;example.com;localhost;127.0.0.1;::1",
    });
  });
});
