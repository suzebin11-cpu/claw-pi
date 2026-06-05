import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const DEFAULT_BASE_URL = "https://api.claw-pi.cn/updates";
const DEFAULT_CHANNEL = "stable";
const DEFAULT_ARCH = "x64";
const DEFAULT_LATEST_FILE = "latest.yml";

function printUsage() {
  console.log(`Usage:
  pnpm verify:update-feed -- --expected-version 0.3.23

Options:
  --feed-url <url>             Feed base URL. Defaults to ${DEFAULT_BASE_URL}/stable/x64
  --channel <name>             Channel when --feed-url is not set. Default: stable
  --arch <name>                Arch when --feed-url is not set. Default: x64
  --latest-file <name>         Update metadata file. Default: latest.yml
  --expected-version <version> Require exact latest.yml version
  --min-version <version>      Require latest.yml version >= value
  --metadata-only              Check latest.yml, installer URL, blockmap URL, and sizes only
  --timeout-ms <ms>            Per-request timeout. Default: 30000
  --help                       Show this help
`);
}

function parseArgs(argv) {
  const args = {
    arch: process.env.NEXU_DESKTOP_TARGET_ARCH ?? DEFAULT_ARCH,
    channel: process.env.NEXU_DESKTOP_UPDATE_CHANNEL ?? DEFAULT_CHANNEL,
    expectedVersion: null,
    feedUrl: process.env.CLAWPI_UPDATE_FEED_URL ?? null,
    latestFile: DEFAULT_LATEST_FILE,
    metadataOnly: false,
    minVersion: null,
    timeoutMs: 30_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (name) {
      case "--arch":
        args.arch = readValue();
        break;
      case "--channel":
        args.channel = readValue();
        break;
      case "--expected-version":
        args.expectedVersion = readValue();
        break;
      case "--feed-url":
        args.feedUrl = readValue();
        break;
      case "--latest-file":
        args.latestFile = readValue();
        break;
      case "--metadata-only":
        args.metadataOnly = true;
        break;
      case "--min-version":
        args.minVersion = readValue();
        break;
      case "--timeout-ms":
        args.timeoutMs = Number.parseInt(readValue(), 10);
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
          throw new Error("--timeout-ms must be a positive integer");
        }
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function buildFeedUrl(args) {
  if (args.feedUrl) {
    return trimTrailingSlash(args.feedUrl);
  }
  return `${DEFAULT_BASE_URL}/${args.channel}/${args.arch}`;
}

function stripYamlQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseElectronLatestYml(content) {
  const result = {
    files: [],
    path: null,
    releaseDate: null,
    sha512: null,
    version: null,
  };
  let currentFile = null;

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, "");
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const rootMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (rootMatch) {
      currentFile = null;
      const [, key, rawValue] = rootMatch;
      const value = stripYamlQuotes(rawValue);
      if (key === "version") result.version = value;
      if (key === "path") result.path = value;
      if (key === "sha512") result.sha512 = value;
      if (key === "releaseDate") result.releaseDate = value;
      continue;
    }

    const fileUrlMatch = line.match(/^\s*-\s+url:\s*(.+)$/u);
    if (fileUrlMatch) {
      currentFile = { url: stripYamlQuotes(fileUrlMatch[1]) };
      result.files.push(currentFile);
      continue;
    }

    const fileFieldMatch = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/u);
    if (fileFieldMatch && currentFile) {
      const [, key, rawValue] = fileFieldMatch;
      const value = stripYamlQuotes(rawValue);
      if (key === "sha512") currentFile.sha512 = value;
      if (key === "size") currentFile.size = Number.parseInt(value, 10);
    }
  }

  return result;
}

function assertLatestYml(latest, options) {
  const failures = [];
  const file = latest.files[0] ?? null;

  if (!latest.version) failures.push("latest.yml is missing version");
  if (!file?.url) failures.push("latest.yml is missing files[0].url");
  if (!file?.sha512) failures.push("latest.yml is missing files[0].sha512");
  if (!Number.isFinite(file?.size) || file.size <= 0) {
    failures.push("latest.yml is missing a positive files[0].size");
  }
  if (!latest.path) failures.push("latest.yml is missing path");
  if (!latest.sha512) failures.push("latest.yml is missing root sha512");
  if (latest.sha512 && file?.sha512 && latest.sha512 !== file.sha512) {
    failures.push("root sha512 does not match files[0].sha512");
  }
  if (latest.path && file?.url && latest.path !== file.url) {
    failures.push("root path does not match files[0].url");
  }
  if (latest.releaseDate && Number.isNaN(Date.parse(latest.releaseDate))) {
    failures.push("releaseDate is not a valid date");
  }
  if (
    options.expectedVersion &&
    latest.version &&
    latest.version !== options.expectedVersion
  ) {
    failures.push(
      `version mismatch: expected ${options.expectedVersion}, got ${latest.version}`,
    );
  }
  if (
    options.minVersion &&
    latest.version &&
    compareVersions(latest.version, options.minVersion) < 0
  ) {
    failures.push(
      `version ${latest.version} is lower than minimum ${options.minVersion}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

function compareVersions(a, b) {
  const aParts = String(a).split(/[.-]/u);
  const bParts = String(b).split(/[.-]/u);
  const length = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < length; index += 1) {
    const rawA = aParts[index] ?? "0";
    const rawB = bParts[index] ?? "0";
    const numA = Number.parseInt(rawA, 10);
    const numB = Number.parseInt(rawB, 10);

    if (Number.isFinite(numA) && Number.isFinite(numB)) {
      if (numA !== numB) return numA > numB ? 1 : -1;
      continue;
    }

    if (rawA !== rawB) return rawA > rawB ? 1 : -1;
  }

  return 0;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.text();
}

async function probeUrl(url, timeoutMs) {
  let response = await fetchWithTimeout(url, { method: "HEAD" }, timeoutMs);
  if (response.ok) {
    return {
      contentLength: parseContentLength(response.headers.get("content-length")),
      ok: true,
      status: response.status,
    };
  }

  response = await fetchWithTimeout(
    url,
    {
      headers: {
        Range: "bytes=0-0",
      },
    },
    timeoutMs,
  );
  if (!response.ok && response.status !== 206) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  await response.body?.cancel().catch(() => undefined);
  return {
    contentLength:
      parseContentRangeTotal(response.headers.get("content-range")) ??
      parseContentLength(response.headers.get("content-length")),
    ok: true,
    status: response.status,
  };
}

function parseContentLength(value) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseContentRangeTotal(value) {
  if (!value) return null;
  const match = value.match(/^bytes\s+\d+-\d+\/(\d+)$/iu);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function downloadAndHash(url, expectedSize, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`${url} returned an empty response body`);
  }

  const hash = createHash("sha512");
  let bytes = 0;

  for await (const chunk of Readable.fromWeb(response.body)) {
    bytes += chunk.length;
    hash.update(chunk);
  }

  if (bytes !== expectedSize) {
    throw new Error(
      `installer size mismatch: expected ${expectedSize}, downloaded ${bytes}`,
    );
  }

  return {
    bytes,
    sha512: hash.digest("base64"),
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const feedUrl = buildFeedUrl(args);
  const latestUrl = `${feedUrl}/${args.latestFile}`;

  console.log(`[verify:update-feed] feed=${feedUrl}`);
  console.log(`[verify:update-feed] latest=${latestUrl}`);

  const latestText = await fetchText(latestUrl, args.timeoutMs);
  const latest = parseElectronLatestYml(latestText);
  assertLatestYml(latest, args);
  console.log(`[ok] latest.yml version=${latest.version}`);

  const installerUrl = new URL(latest.files[0].url, latestUrl).toString();
  const blockmapUrl = `${installerUrl}.blockmap`;

  const installerProbe = await probeUrl(installerUrl, args.timeoutMs);
  if (
    installerProbe.contentLength !== null &&
    installerProbe.contentLength !== latest.files[0].size
  ) {
    throw new Error(
      `installer content-length mismatch: expected ${latest.files[0].size}, got ${installerProbe.contentLength}`,
    );
  }
  console.log(
    `[ok] installer reachable size=${formatBytes(latest.files[0].size)} url=${installerUrl}`,
  );

  const blockmapProbe = await probeUrl(blockmapUrl, args.timeoutMs);
  console.log(
    `[ok] blockmap reachable size=${formatBytes(blockmapProbe.contentLength)} url=${blockmapUrl}`,
  );

  if (!args.metadataOnly) {
    console.log("[verify:update-feed] downloading installer for sha512 check");
    const hashResult = await downloadAndHash(
      installerUrl,
      latest.files[0].size,
      args.timeoutMs,
    );
    if (hashResult.sha512 !== latest.files[0].sha512) {
      throw new Error(
        `installer sha512 mismatch: expected ${latest.files[0].sha512}, got ${hashResult.sha512}`,
      );
    }
    console.log(
      `[ok] installer sha512 verified bytes=${formatBytes(hashResult.bytes)}`,
    );
  } else {
    console.log("[skip] metadata-only mode: installer sha512 download skipped");
  }

  console.log("[verify:update-feed] passed");
}

main().catch((error) => {
  console.error(
    `[verify:update-feed] failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
