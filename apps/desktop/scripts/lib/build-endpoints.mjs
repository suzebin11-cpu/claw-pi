import { lookup } from "node:dns/promises";
import { access, readFile, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";

export const PRODUCTION_CLOUD_URL = "http://47.108.215.151:9080";
export const PRODUCTION_LINK_URL = "https://api.openlux.ai";

const FORMAL_BUILD_SOURCES = new Set(["release", "nightly-prod"]);
const DNS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ENOTFOUND",
]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().replace(/\/+$/u, "")
    : undefined;
}

export function resolveBuildEndpoints(env = {}, existingConfig = {}) {
  return {
    NEXU_CLOUD_URL:
      readNonEmptyString(env.NEXU_CLOUD_URL) ??
      readNonEmptyString(existingConfig.NEXU_CLOUD_URL) ??
      PRODUCTION_CLOUD_URL,
    NEXU_LINK_URL:
      readNonEmptyString(env.NEXU_LINK_URL) ??
      readNonEmptyString(existingConfig.NEXU_LINK_URL) ??
      PRODUCTION_LINK_URL,
  };
}

export function isFormalBuildConfig(config) {
  return (
    config.NEXU_SENTRY_ENV === "prod" ||
    FORMAL_BUILD_SOURCES.has(config.NEXU_DESKTOP_BUILD_SOURCE)
  );
}

function parseEndpoint(value, key) {
  const normalized = readNonEmptyString(value);
  if (!normalized) {
    throw new Error(`[build-endpoints] ${key} is missing.`);
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(
      `[build-endpoints] ${key} is not a valid URL: ${normalized}`,
    );
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `[build-endpoints] ${key} must be a credential-free HTTP(S) origin.`,
    );
  }

  return normalized;
}

export function assertBuildEndpointPolicy(config) {
  const cloudUrl = parseEndpoint(config.NEXU_CLOUD_URL, "NEXU_CLOUD_URL");
  const linkUrl = parseEndpoint(config.NEXU_LINK_URL, "NEXU_LINK_URL");

  if (
    isFormalBuildConfig(config) &&
    (cloudUrl !== PRODUCTION_CLOUD_URL || linkUrl !== PRODUCTION_LINK_URL)
  ) {
    throw new Error(
      `[build-endpoints] Formal packages must use Cloud=${PRODUCTION_CLOUD_URL} and Link=${PRODUCTION_LINK_URL}; received Cloud=${cloudUrl}, Link=${linkUrl}.`,
    );
  }

  return { cloudUrl, linkUrl };
}

function readErrorCode(error) {
  if (!error || typeof error !== "object") return "";
  if (typeof error.code === "string") return error.code;
  return readErrorCode(error.cause);
}

function describeProbeError(error) {
  const code = readErrorCode(error);
  if (DNS_ERROR_CODES.has(code)) return `DNS failure (${code})`;
  if (TLS_ERROR_CODES.has(code)) return `TLS failure (${code})`;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "timeout";
  }
  return error instanceof Error ? error.message : String(error);
}

async function probeEndpoint(
  label,
  baseUrl,
  acceptedStatuses,
  { fetchImpl, lookupImpl, timeoutMs },
) {
  const url = new URL("v1/models", `${baseUrl}/`);
  let response;
  try {
    if (!isIP(url.hostname)) {
      await lookupImpl(url.hostname);
    }
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `[build-endpoints] ${label} probe failed for ${url.origin}: ${describeProbeError(error)}`,
    );
  }

  if (!acceptedStatuses.has(response.status)) {
    throw new Error(
      `[build-endpoints] ${label} probe returned unexpected HTTP ${response.status} from ${url}.`,
    );
  }

  return { label, url: url.toString(), status: response.status };
}

export async function verifyBuildEndpointConnectivity(
  config,
  { fetchImpl = fetch, lookupImpl = lookup, timeoutMs = 10_000 } = {},
) {
  const { cloudUrl, linkUrl } = assertBuildEndpointPolicy(config);
  return Promise.all([
    probeEndpoint("Cloud", cloudUrl, new Set([200]), {
      fetchImpl,
      lookupImpl,
      timeoutMs,
    }),
    probeEndpoint("Link", linkUrl, new Set([200, 401, 403]), {
      fetchImpl,
      lookupImpl,
      timeoutMs,
    }),
  ]);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function verifyPackagedBuildEndpoints({
  releaseRoot,
  platform,
  productName = "Claw-Pi",
  env = process.env,
}) {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const candidates =
    platform === "win32"
      ? [resolve(releaseRoot, "win-unpacked", "resources", "build-config.json")]
      : entries
          .filter(
            (entry) => entry.isDirectory() && entry.name.startsWith("mac"),
          )
          .map((entry) =>
            resolve(
              releaseRoot,
              entry.name,
              `${productName}.app`,
              "Contents",
              "Resources",
              "build-config.json",
            ),
          );
  const configPaths = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) configPaths.push(candidate);
  }

  if (configPaths.length === 0) {
    throw new Error(
      `[build-endpoints] No packaged build-config.json found under ${releaseRoot}.`,
    );
  }

  const results = [];
  for (const configPath of configPaths) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assertBuildEndpointPolicy(config);

    if (env.NEXU_DESKTOP_SKIP_ENDPOINT_VALIDATION === "1") {
      if (isFormalBuildConfig(config)) {
        throw new Error(
          "[build-endpoints] Endpoint connectivity validation cannot be skipped for a formal package.",
        );
      }
      console.warn(
        `[build-endpoints] skipped connectivity probe for local package ${configPath}`,
      );
      results.push({ configPath, probes: [] });
      continue;
    }

    const probes = await verifyBuildEndpointConnectivity(config);
    console.log(
      `[build-endpoints] verified ${configPath}: ${probes
        .map((probe) => `${probe.label}=HTTP ${probe.status}`)
        .join(", ")}`,
    );
    results.push({ configPath, probes });
  }

  return results;
}
