import type { Session } from "electron";
import {
  type ElectronProxyConfig,
  type ProxyPolicy,
  type ResolvedSystemProxy,
  buildElectronProxyConfig,
  parseResolvedProxy,
  redactProxyUrl,
} from "../../shared/proxy-config";

/**
 * Representative external URL used to ask Chromium's proxy resolver "what would
 * you use to reach the internet?". Any external HTTPS origin works; a PAC
 * script keyed on hostname could in principle answer differently per host, but
 * a single representative probe is what child processes can express via
 * HTTP_PROXY anyway.
 */
const PROXY_PROBE_URL = "https://api.openlux.ai/v1/models";

/** Cap on system proxy resolution so a hostile PAC script cannot stall boot. */
const RESOLVE_TIMEOUT_MS = 3_000;

export type ProxyResolution = {
  label: string;
  url: string;
  result: string;
};

export type ProxyDiagnosticsSnapshot = {
  source: ProxyPolicy["source"];
  env: ProxyPolicy["diagnostics"];
  bypass: string[];
  electron: {
    mode: ElectronProxyConfig["mode"];
    proxyRulesRedacted: string | null;
    proxyBypassRules: string[];
  };
  resolutions: ProxyResolution[];
};

type ElectronSessionLike = Pick<
  Session,
  "setProxy" | "closeAllConnections" | "resolveProxy"
>;

export class ProxyManager {
  constructor(private readonly session: ElectronSessionLike) {}

  async applyPolicy(policy: ProxyPolicy): Promise<ElectronProxyConfig> {
    const config = buildElectronProxyConfig(policy);
    await this.session.setProxy(config);
    await this.session.closeAllConnections();
    return config;
  }

  /**
   * Ask Chromium to resolve the OS proxy for a representative external URL.
   *
   * Must be called after {@link applyPolicy} so the resolver reflects the
   * session's configured mode. Returns null when the network is direct, when
   * only a SOCKS proxy is configured, or when resolution fails or times out —
   * in every one of those cases the correct fallback is a direct connection.
   */
  async resolveSystemProxy(
    probeUrl: string = PROXY_PROBE_URL,
  ): Promise<ResolvedSystemProxy | null> {
    try {
      const resolved = await withTimeout(
        this.session.resolveProxy(probeUrl),
        RESOLVE_TIMEOUT_MS,
      );
      return parseResolvedProxy(resolved);
    } catch {
      return null;
    }
  }

  async collectDiagnostics(
    policy: ProxyPolicy,
    targets: Array<{ label: string; url: string }>,
  ): Promise<ProxyDiagnosticsSnapshot> {
    const electronConfig = buildElectronProxyConfig(policy);
    const resolutions = await Promise.all(
      targets.map(async (target) => ({
        label: target.label,
        url: target.url,
        result: await this.session.resolveProxy(target.url),
      })),
    );

    return {
      source: policy.source,
      env: { ...policy.diagnostics },
      bypass: [...policy.bypass],
      electron: {
        mode: electronConfig.mode,
        proxyRulesRedacted:
          "proxyRules" in electronConfig
            ? redactProxyRules(electronConfig.proxyRules)
            : null,
        proxyBypassRules:
          "proxyBypassRules" in electronConfig
            ? electronConfig.proxyBypassRules
                .split(";")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            : [],
      },
      resolutions,
    };
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function redactProxyRules(proxyRules: string): string {
  return proxyRules
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [scheme, value] = entry.split("=", 2);
      if (!value) {
        return redactProxyUrl(entry) ?? "***";
      }
      return `${scheme}=${redactProxyUrl(value) ?? "***"}`;
    })
    .join(";");
}
