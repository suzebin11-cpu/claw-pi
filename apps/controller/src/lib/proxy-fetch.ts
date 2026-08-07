import dns from "node:dns";
import http from "node:http";
import net from "node:net";

export type ProxyFetchOptions = RequestInit & {
  /**
   * Deadline for the whole request. Defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}; pass `null` to opt out entirely for
   * genuinely long-lived responses such as streamed completions.
   */
  timeoutMs?: number | null;
};

type ProxyFetchEnv = {
  httpProxy: string | null;
  httpsProxy: string | null;
  allProxy: string | null;
  noProxy: string[];
};

type HttpModuleWithProxySupport = typeof http & {
  setGlobalProxyFromEnv?: (
    proxyEnv?: NodeJS.ProcessEnv,
  ) => (() => void) | undefined;
};

const REQUIRED_LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"];
const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";

/**
 * Per-attempt window for the happy-eyeballs family race.
 *
 * Node's default is 250ms: if the first address family does not complete its
 * TCP handshake within that window, the other family is raced. On Windows the
 * common failure is an AAAA record with no working IPv6 route, where 250ms is
 * also too tight for a legitimately slow first hop over a corporate proxy or
 * VPN — the retry storm shows up as UND_ERR_CONNECT_TIMEOUT. 500ms keeps
 * failover fast while tolerating a slow-but-working link.
 */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 500;

/**
 * Fallback deadline for callers that do not pass one.
 *
 * Without this, a request whose socket never progresses hangs forever and the
 * caller (health loop, model listing, page bootstrap) hangs with it — the
 * "page initialization takes a very long time" symptom. 30s is well above any
 * healthy non-streaming call while still guaranteeing the promise settles.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

let networkDefaultsApplied = false;

/**
 * Apply process-wide connection defaults that make egress resilient on Windows.
 *
 * Two failure modes motivate this:
 *  1. IPv6 blackholes. A host with an AAAA record but no usable IPv6 route
 *     stalls until the connect timeout fires. Enabling autoSelectFamily races
 *     both families so IPv4 wins immediately instead of after a long hang.
 *  2. DNS ordering. `verbatim` result order can put an unreachable IPv6 address
 *     first; `ipv4first` biases toward the family that actually works on the
 *     affected machines.
 *
 * Both are safe on networks that do have working IPv6: the race simply resolves
 * to whichever family connects first.
 */
export function ensureNetworkDefaults(): void {
  if (networkDefaultsApplied) {
    return;
  }
  networkDefaultsApplied = true;

  try {
    net.setDefaultAutoSelectFamily?.(true);
    net.setDefaultAutoSelectFamilyAttemptTimeout?.(
      AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    );
  } catch {
    // Older runtimes lack these setters; the defaults remain in effect.
  }

  try {
    dns.setDefaultResultOrder?.("ipv4first");
  } catch {
    // Non-fatal: DNS ordering stays at the runtime default.
  }
}
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

let configuredProxyKey: string | null = null;
let restoreProxyConfig: (() => void) | null = null;

function readEnvValue(
  env: NodeJS.ProcessEnv,
  upperKey: "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY",
): string | null {
  const upperValue = env[upperKey];
  if (typeof upperValue === "string" && upperValue.trim().length > 0) {
    return upperValue.trim();
  }

  const lowerValue = env[upperKey.toLowerCase()];
  if (typeof lowerValue === "string" && lowerValue.trim().length > 0) {
    return lowerValue.trim();
  }

  return null;
}

export function mergeNoProxyEntries(
  input: string | string[] | null | undefined,
): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];

  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of [...values, ...REQUIRED_LOOPBACK_BYPASS]) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(normalized);
  }

  return merged;
}

export function readProxyFetchEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProxyFetchEnv {
  const allProxy = readEnvValue(env, "ALL_PROXY");

  return {
    httpProxy: readEnvValue(env, "HTTP_PROXY") ?? allProxy,
    httpsProxy: readEnvValue(env, "HTTPS_PROXY") ?? allProxy,
    allProxy,
    noProxy: mergeNoProxyEntries(readEnvValue(env, "NO_PROXY")),
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return REQUIRED_LOOPBACK_BYPASS.includes(normalized);
}

function noProxyEntryMatchesHostname(hostname: string, entry: string): boolean {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedEntry = normalizeHostname(entry.trim());

  if (normalizedEntry === "*") {
    return true;
  }

  if (normalizedEntry.length === 0) {
    return false;
  }

  const bareEntry = normalizedEntry.startsWith(".")
    ? normalizedEntry.slice(1)
    : normalizedEntry;

  return (
    normalizedHost === bareEntry ||
    normalizedHost.endsWith(`.${bareEntry}`) ||
    normalizedHost.endsWith(normalizedEntry)
  );
}

export function shouldBypassProxy(
  input: string | URL,
  noProxyEntries?: string[],
): boolean {
  const url = typeof input === "string" ? new URL(input) : input;

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return true;
  }

  if (isLoopbackHostname(url.hostname)) {
    return true;
  }

  const entries = noProxyEntries ?? readProxyFetchEnv().noProxy;
  return entries.some((entry) =>
    noProxyEntryMatchesHostname(url.hostname, entry),
  );
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

function summarizeRequestTarget(input: string | URL): string {
  try {
    const url = typeof input === "string" ? new URL(input) : input;
    return url.origin;
  } catch {
    return "remote target";
  }
}

function sanitizeErrorMessage(
  message: string,
  proxyEnv: ProxyFetchEnv,
): string {
  let sanitized = message;

  for (const value of [
    proxyEnv.httpProxy,
    proxyEnv.httpsProxy,
    proxyEnv.allProxy,
  ]) {
    if (!value) {
      continue;
    }

    sanitized = sanitized.split(value).join(redactProxyUrl(value) ?? "***");
  }

  return sanitized.replace(/([a-z]+:\/\/)([^@\s/]+)@/giu, "$1***:***@");
}

function createAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  timedOut: () => boolean;
  abortedByCaller: () => boolean;
} {
  if (!signal && timeoutMs === undefined) {
    return {
      signal: undefined,
      cleanup: () => {},
      timedOut: () => false,
      abortedByCaller: () => false,
    };
  }

  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;
  let didTimeout = false;
  let callerAborted = false;

  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      abortFromCaller();
    } else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
    }
  }

  if (timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal) {
        signal.removeEventListener("abort", abortFromCaller);
      }
    },
    timedOut: () => didTimeout,
    abortedByCaller: () => callerAborted,
  };
}

function ensureGlobalProxySupport(proxyEnv: ProxyFetchEnv): void {
  if (!proxyEnv.httpProxy && !proxyEnv.httpsProxy) {
    return;
  }

  process.env.HTTP_PROXY = proxyEnv.httpProxy ?? "";
  process.env.HTTPS_PROXY = proxyEnv.httpsProxy ?? "";
  process.env.NO_PROXY = proxyEnv.noProxy.join(",");
  process.env[NODE_USE_ENV_PROXY] = "1";

  const key = JSON.stringify(proxyEnv);
  if (configuredProxyKey === key) {
    return;
  }

  restoreProxyConfig?.();
  restoreProxyConfig = null;
  configuredProxyKey = key;

  const httpWithProxySupport = http as HttpModuleWithProxySupport;
  if (typeof httpWithProxySupport.setGlobalProxyFromEnv !== "function") {
    return;
  }

  const restore = httpWithProxySupport.setGlobalProxyFromEnv({
    ...process.env,
    HTTP_PROXY: proxyEnv.httpProxy ?? undefined,
    HTTPS_PROXY: proxyEnv.httpsProxy ?? undefined,
    NO_PROXY: proxyEnv.noProxy.join(","),
  });

  restoreProxyConfig = typeof restore === "function" ? restore : null;
}

function createTimeoutError(input: string | URL, timeoutMs: number): Error {
  const error = new Error(
    `Request to ${summarizeRequestTarget(input)} timed out after ${timeoutMs}ms`,
  );
  error.name = "TimeoutError";
  return error;
}

function createAbortError(input: string | URL): Error {
  const error = new Error(
    `Request to ${summarizeRequestTarget(input)} was aborted`,
  );
  error.name = "AbortError";
  return error;
}

function createProxySafeError(
  error: unknown,
  input: string | URL,
  proxyEnv: ProxyFetchEnv,
): Error {
  if (!(error instanceof Error)) {
    return new Error(`Request to ${summarizeRequestTarget(input)} failed`);
  }

  const safeError = new Error(sanitizeErrorMessage(error.message, proxyEnv));
  safeError.name = error.name;
  const directCode = (error as Error & { code?: unknown }).code;
  const causeCode =
    error.cause && typeof error.cause === "object"
      ? (error.cause as { code?: unknown }).code
      : undefined;
  const code =
    typeof directCode === "string"
      ? directCode
      : typeof causeCode === "string"
        ? causeCode
        : undefined;
  if (code) {
    (safeError as Error & { code?: string }).code = code;
  }
  return safeError;
}

function isRetryableProxyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code =
    typeof (error as Error & { code?: unknown }).code === "string"
      ? (error as Error & { code: string }).code
      : "";
  const message = error.message.toUpperCase();
  return (
    TRANSIENT_NETWORK_ERROR_CODES.has(code) ||
    message.includes("UND_ERR_CONNECT_TIMEOUT") ||
    message.includes("FETCH FAILED") ||
    message.includes("CONNECT TIMEOUT")
  );
}

/**
 * A request body can only be sent twice if it is a fully-buffered value.
 * ReadableStream bodies are consumed by the first attempt, so replaying them
 * would send an empty or truncated payload.
 */
function isReplayableBody(body: unknown): boolean {
  if (body === null || body === undefined) {
    return true;
  }
  return !(
    typeof ReadableStream !== "undefined" && body instanceof ReadableStream
  );
}

function isIdempotentMethod(method: string | undefined): boolean {
  return (
    method === undefined ||
    method.toUpperCase() === "GET" ||
    method.toUpperCase() === "HEAD" ||
    method.toUpperCase() === "OPTIONS"
  );
}

export async function proxyFetch(
  input: string | URL,
  options: ProxyFetchOptions = {},
): Promise<Response> {
  const { timeoutMs: rawTimeoutMs, signal: rawSignal, ...init } = options;
  const signal = rawSignal ?? undefined;
  // `null` opts out; `undefined` (unspecified) falls back to the default so no
  // request can hang forever.
  const timeoutMs =
    rawTimeoutMs === null
      ? undefined
      : (rawTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const proxyEnv = readProxyFetchEnv();
  const requestUrl = typeof input === "string" ? new URL(input) : input;

  ensureNetworkDefaults();
  ensureGlobalProxySupport(proxyEnv);

  const abortState = createAbortSignal(signal, timeoutMs);

  try {
    const requestInit = { ...init, signal: abortState.signal };
    try {
      return await fetch(requestUrl, requestInit);
    } catch (error) {
      // Retry only safe, idempotent requests. A short backoff covers transient
      // Windows proxy/DNS/connect races without duplicating model mutations or
      // auth operations.
      if (!isIdempotentMethod(init.method) || !isRetryableProxyError(error)) {
        throw error;
      }
      // Never retry once the deadline expired or the caller gave up: the second
      // attempt would abort instantly and only obscure the real reason.
      if (abortState.timedOut() || abortState.abortedByCaller()) {
        throw error;
      }
      // A consumed stream body cannot be replayed.
      if (!isReplayableBody(init.body)) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
      });
      return await fetch(requestUrl, requestInit);
    }
  } catch (error) {
    if (abortState.timedOut() && timeoutMs !== undefined) {
      throw createTimeoutError(requestUrl, timeoutMs);
    }

    if (abortState.abortedByCaller()) {
      throw createAbortError(requestUrl);
    }

    throw createProxySafeError(error, requestUrl, proxyEnv);
  } finally {
    abortState.cleanup();
  }
}

export async function proxyFetchJson<T>(
  input: string | URL,
  options: ProxyFetchOptions = {},
): Promise<T> {
  const response = await proxyFetch(input, options);
  return (await response.json()) as T;
}
