export type ProxySource = "env" | "system" | "direct";

/**
 * A proxy discovered from the OS (WinHTTP/PAC on Windows, network settings on
 * macOS) rather than from environment variables. Electron's networking stack
 * resolves this automatically in `mode: "system"`, but Node child processes do
 * not — they only honour HTTP_PROXY/HTTPS_PROXY. Carrying the resolved value
 * here lets us hand the same proxy to the controller/openclaw sidecars.
 */
export type ResolvedSystemProxy = {
  /** Proxy origin in `http://host:port` form. */
  url: string;
};

export type ProxyEnvConfig = {
  httpProxy: string | null;
  httpsProxy: string | null;
  allProxy: string | null;
  noProxy: string[];
};

export type ProxyPolicy = {
  source: ProxySource;
  env: ProxyEnvConfig;
  bypass: string[];
  diagnostics: {
    httpProxyRedacted: string | null;
    httpsProxyRedacted: string | null;
    allProxyRedacted: string | null;
  };
};

export type ElectronProxyConfig =
  | {
      mode: "fixed_servers";
      proxyRules: string;
      proxyBypassRules: string;
    }
  | {
      mode: "system" | "direct";
    };

const REQUIRED_LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"];

function readEnvValue(
  env: Record<string, string | undefined>,
  upperKey: string,
): string | null {
  const upper = env[upperKey];
  if (typeof upper === "string" && upper.trim().length > 0) {
    return upper.trim();
  }

  const lower = env[upperKey.toLowerCase()];
  if (typeof lower === "string" && lower.trim().length > 0) {
    return lower.trim();
  }

  return null;
}

export function mergeNoProxyEntries(input: string | string[] | null): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];

  const ordered = [...values, ...REQUIRED_LOOPBACK_BYPASS];
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of ordered) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }

  return output;
}

export function redactProxyUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "***";
  }
}

/**
 * Parse an Electron `session.resolveProxy()` result into a proxy URL.
 *
 * The PAC-style return value is a semicolon-separated preference list, e.g.
 * `"PROXY proxy.corp:8080; DIRECT"` or `"DIRECT"`. We take the first usable
 * proxy entry. `DIRECT` (no proxy needed) yields null so callers keep a direct
 * connection instead of inventing a proxy.
 */
export function parseResolvedProxy(
  resolved: string | null | undefined,
): ResolvedSystemProxy | null {
  if (typeof resolved !== "string") {
    return null;
  }

  for (const rawEntry of resolved.split(";")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }

    const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(entry);
    if (!match) {
      // "DIRECT" and anything unrecognized: keep scanning the preference list.
      continue;
    }

    const scheme = match[1].toUpperCase();
    const authority = match[2];
    if (authority.length === 0) {
      continue;
    }

    // Node's fetch proxy support only understands http(s) proxies. Skip SOCKS
    // rather than emitting an env var that would break every child request.
    if (scheme === "SOCKS" || scheme === "SOCKS4" || scheme === "SOCKS5") {
      continue;
    }

    const prefix = scheme === "HTTPS" ? "https://" : "http://";
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(authority)
      ? authority
      : `${prefix}${authority}`;

    try {
      // Normalize and reject malformed authorities early.
      return { url: new URL(url).origin };
    } catch {
      // Malformed authority: fall through to the next preference-list entry.
    }
  }

  return null;
}

/**
 * Fold a system-resolved proxy into an existing policy so child processes get
 * concrete HTTP_PROXY/HTTPS_PROXY values. Explicit env configuration always
 * wins: if the user set the vars themselves, we do not second-guess them.
 */
export function withResolvedSystemProxy(
  policy: ProxyPolicy,
  resolved: ResolvedSystemProxy | null,
): ProxyPolicy {
  if (policy.source !== "system" || !resolved) {
    return policy;
  }

  return {
    ...policy,
    env: {
      ...policy.env,
      httpProxy: resolved.url,
      httpsProxy: resolved.url,
    },
    diagnostics: {
      ...policy.diagnostics,
      httpProxyRedacted: redactProxyUrl(resolved.url),
      httpsProxyRedacted: redactProxyUrl(resolved.url),
    },
  };
}

export function readProxyPolicy(
  env: Record<string, string | undefined>,
  options?: {
    defaultSource?: Exclude<ProxySource, "env">;
  },
): ProxyPolicy {
  const httpProxy = readEnvValue(env, "HTTP_PROXY");
  const httpsProxy = readEnvValue(env, "HTTPS_PROXY");
  const allProxy = readEnvValue(env, "ALL_PROXY");
  const noProxy = mergeNoProxyEntries(readEnvValue(env, "NO_PROXY"));
  const hasExplicitProxy = [httpProxy, httpsProxy, allProxy].some(Boolean);

  return {
    source: hasExplicitProxy ? "env" : (options?.defaultSource ?? "system"),
    env: {
      httpProxy,
      httpsProxy,
      allProxy,
      noProxy,
    },
    bypass: noProxy,
    diagnostics: {
      httpProxyRedacted: redactProxyUrl(httpProxy),
      httpsProxyRedacted: redactProxyUrl(httpsProxy),
      allProxyRedacted: redactProxyUrl(allProxy),
    },
  };
}

/**
 * Build the proxy-related env vars handed to the controller/openclaw sidecars.
 *
 * Node does not read the OS proxy settings, so a `source: "system"` policy only
 * reaches child processes if it was first resolved through
 * {@link withResolvedSystemProxy}. Without that, sidecars connect DIRECT on
 * proxy-only networks and every model request fails with
 * UND_ERR_CONNECT_TIMEOUT.
 */
export function buildChildProcessProxyEnv(
  policy: ProxyPolicy,
): Record<string, string> {
  const nextEnv: Record<string, string> = {
    NO_PROXY: policy.bypass.join(","),
  };

  const hasExplicitProxy = [
    policy.env.httpProxy,
    policy.env.httpsProxy,
    policy.env.allProxy,
  ].some(Boolean);

  if (hasExplicitProxy) {
    nextEnv.NODE_USE_ENV_PROXY = "1";
  }

  if (policy.env.httpProxy) {
    nextEnv.HTTP_PROXY = policy.env.httpProxy;
  }

  if (policy.env.httpsProxy) {
    nextEnv.HTTPS_PROXY = policy.env.httpsProxy;
  }

  if (policy.env.allProxy) {
    nextEnv.ALL_PROXY = policy.env.allProxy;
  }

  return nextEnv;
}

export function buildElectronProxyConfig(
  policy: ProxyPolicy,
): ElectronProxyConfig {
  if (policy.source === "system") {
    return { mode: "system" };
  }

  if (policy.source === "direct") {
    return { mode: "direct" };
  }

  const httpProxy = policy.env.httpProxy ?? policy.env.allProxy;
  const httpsProxy = policy.env.httpsProxy ?? policy.env.allProxy;
  const proxyRules = [
    httpProxy ? `http=${httpProxy}` : null,
    httpsProxy ? `https=${httpsProxy}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(";");

  if (proxyRules.length === 0) {
    return { mode: "direct" };
  }

  return {
    mode: "fixed_servers",
    proxyRules,
    proxyBypassRules: mergeNoProxyEntries(["<local>", ...policy.bypass]).join(
      ";",
    ),
  };
}
