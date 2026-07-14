import { execFile, execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import * as path from "node:path";
import { getOpenclawSkillsDir } from "../../shared/desktop-paths";
import { buildChildProcessProxyEnv } from "../../shared/proxy-config";
import type { DesktopRuntimeConfig } from "../../shared/runtime-config";
import { getWorkspaceRoot } from "../../shared/workspace-paths";
import { liftBundledExtensionDepsSync } from "./lift-bundled-extension-deps";
import type { RuntimeUnitManifest } from "./types";

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function resolveElectronNodeRunner(isPackaged: boolean): string {
  if (isPackaged) {
    return process.execPath;
  }

  const candidates = [
    normalizeNodeCandidate(process.env.npm_node_execpath),
    normalizeNodeCandidate(process.env.NODE),
    normalizeNodeCandidate(process.env.NODE_EXE),
  ];

  for (const candidate of candidates) {
    if (candidate) {
      return candidate;
    }
  }

  try {
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    const lookupTarget = process.platform === "win32" ? "node.exe" : "node";
    const resolved = execFileSync(lookupCommand, [lookupTarget], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((entry) => normalizeNodeCandidate(entry))
      .find((entry) => entry !== undefined);

    if (resolved) {
      return resolved;
    }
  } catch {
    // Fall through to the Electron binary if no standalone Node is discoverable.
  }

  return process.execPath;
}

function normalizeNodeCandidate(
  candidate: string | undefined,
): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed || !existsSync(trimmed)) {
    return undefined;
  }

  return trimmed;
}

/**
 * Build a PATH prefix that puts a Node.js >= 22 binary first.
 * OpenClaw requires Node 22.12+; in dev mode the system `node` may be
 * older (e.g. nvm defaulting to v20).  We scan NVM_DIR for a v22 install
 * and, if found, prepend its bin directory to the inherited PATH.
 */
function buildNode22Path(): string | undefined {
  const nvmDir = process.env.NVM_DIR;
  if (!nvmDir) return undefined;
  try {
    const versionsDir = path.resolve(nvmDir, "versions/node");
    const dirs = readdirSync(versionsDir)
      .filter((d) => d.startsWith("v22."))
      .sort()
      .reverse();
    for (const d of dirs) {
      const binDir = path.resolve(versionsDir, d, "bin");
      if (existsSync(path.resolve(binDir, "node"))) {
        return `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
      }
    }
  } catch {
    /* nvm dir not present or unreadable */
  }
  return undefined;
}

function supportsOpenclawRuntime(
  nodeBinaryPath: string,
  openclawSidecarRoot: string,
): boolean {
  try {
    execFileSync(
      nodeBinaryPath,
      [
        "-e",
        'require(require("node:path").resolve(process.argv[1], "node_modules/@snazzah/davey"))',
        openclawSidecarRoot,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_PATH: "",
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer the current session's Node binary when it can boot OpenClaw.
 * Fall back to the previous Node 22 heuristic for older dev shells.
 *
 * The desktop gateway used to force Node 22 because OpenClaw historically
 * required 22.12+. Some local sidecars are instead bound to the current
 * session's Node ABI (for example Node 24), so we should try that first.
 */
function buildOpenclawNodePath(
  openclawSidecarRoot: string,
): string | undefined {
  const currentPath = process.env.PATH ?? "";
  const candidates = [normalizeNodeCandidate(process.env.NODE)];

  try {
    candidates.push(
      normalizeNodeCandidate(
        execFileSync("which", ["node"], { encoding: "utf8" }),
      ),
    );
  } catch {
    /* current PATH may not expose node */
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (!supportsOpenclawRuntime(candidate, openclawSidecarRoot)) {
      continue;
    }

    const candidateDir = path.dirname(candidate);
    const currentFirstPath = currentPath.split(path.delimiter)[0] ?? "";
    if (candidateDir === currentFirstPath) {
      return undefined;
    }

    return `${candidateDir}${path.delimiter}${currentPath}`;
  }

  return buildNode22Path();
}

export function buildSkillNodePath(
  electronRoot: string,
  isPackaged: boolean,
  inheritedNodePath = process.env.NODE_PATH,
): string {
  const bundledModulesPath = isPackaged
    ? path.resolve(electronRoot, "bundled-node-modules")
    : path.resolve(electronRoot, "node_modules");
  const inheritedEntries = (inheritedNodePath ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);

  return Array.from(new Set([bundledModulesPath, ...inheritedEntries])).join(
    path.delimiter,
  );
}

type ArchiveInfo = {
  archivePath: string;
  format: "tar.gz" | "zip" | "7z";
};

function resolvePayloadArchive(
  packagedSidecarRoot: string,
): ArchiveInfo | null {
  // Prefer .7z on Windows: LZMA2 ratio + single sealed blob keeps NSIS
  // install time and Defender scanning minimal. See
  // scripts/prepare-openclaw-sidecar.mjs for the rationale.
  const sevenZipPath = path.resolve(packagedSidecarRoot, "payload.7z");
  if (existsSync(sevenZipPath))
    return { archivePath: sevenZipPath, format: "7z" };
  const tarPath = path.resolve(packagedSidecarRoot, "payload.tar.gz");
  if (existsSync(tarPath)) return { archivePath: tarPath, format: "tar.gz" };
  const zipPath = path.resolve(packagedSidecarRoot, "payload.zip");
  if (existsSync(zipPath)) return { archivePath: zipPath, format: "zip" };
  return null;
}

function resolveArchiveStamp(
  packagedSidecarRoot: string,
  archive: ArchiveInfo,
): string {
  const metadataPath = path.resolve(packagedSidecarRoot, "metadata.json");

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      fingerprint?: unknown;
    };
    const fingerprint = metadata.fingerprint;
    if (typeof fingerprint === "string" && fingerprint.trim().length > 0) {
      return `fingerprint:${fingerprint.trim()}`;
    }
  } catch {
    // Older packages do not include archived sidecar metadata. Keep the legacy
    // stamp format so existing extracted installs remain compatible.
  }

  const archiveStat = statSync(archive.archivePath);
  return `${archiveStat.size}:${archiveStat.mtimeMs}`;
}

/**
 * Resolve the bundled 7za.exe / 7za binary that ships alongside the app in
 * packaged mode. `electronRoot` in packaged builds points at
 * `resources/app/` (asar) or `resources/`, so the sibling `bin/7za.exe`
 * that `extraResources` injects can be reached via resourcesPath.
 *
 * Returns null if no bundled binary is found; callers must fall back to
 * a PATH lookup in that case.
 */
function resolveBundled7zaPath(): string | null {
  const resourcesPath = process.resourcesPath;
  if (!resourcesPath) return null;

  const binaryName = process.platform === "win32" ? "7za.exe" : "7za";
  const candidate = path.resolve(resourcesPath, "bin", binaryName);
  return existsSync(candidate) ? candidate : null;
}

function removeDirectorySync(dir: string): void {
  if (!existsSync(dir)) return;
  if (process.platform === "win32") {
    try {
      execSync(`rmdir /s /q "${dir}"`, { stdio: "ignore", timeout: 30_000 });
    } catch {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function removeDirectoryAsync(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  if (process.platform === "win32") {
    try {
      execSync(`rmdir /s /q "${dir}"`, { stdio: "ignore", timeout: 30_000 });
    } catch {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  } else {
    await rm(dir, { recursive: true, force: true });
  }
}

function robustRenameSync(source: string, dest: string): void {
  try {
    renameSync(source, dest);
  } catch (err: unknown) {
    if (
      process.platform !== "win32" ||
      (err as NodeJS.ErrnoException).code !== "EPERM"
    )
      throw err;
    cpSync(source, dest, { recursive: true, dereference: true });
    rmSync(source, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }
}

async function robustRenameAsync(source: string, dest: string): Promise<void> {
  try {
    await rename(source, dest);
  } catch (err: unknown) {
    if (
      process.platform !== "win32" ||
      (err as NodeJS.ErrnoException).code !== "EPERM"
    )
      throw err;
    await cp(source, dest, { recursive: true, dereference: true });
    await rm(source, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }
}

function extractArchiveSync(archive: ArchiveInfo, destDir: string): void {
  if (archive.format === "7z") {
    const bundled = resolveBundled7zaPath();
    if (!bundled) {
      throw new Error(
        "No bundled 7za binary found to extract payload.7z. " +
          "Expected at resources/bin/7za.exe (Windows) or resources/bin/7za.",
      );
    }
    // -bd: disable progress indicator (cleaner logs, less stdout chatter)
    // -y:  yes to all prompts
    // -o:  output dir (no space after -o per 7z CLI syntax)
    execFileSync(bundled, [
      "x",
      archive.archivePath,
      `-o${destDir}`,
      "-bd",
      "-y",
    ]);
    return;
  }
  if (archive.format === "tar.gz") {
    execFileSync("tar", ["-xzf", archive.archivePath, "-C", destDir]);
  } else {
    execFileSync("tar", ["-xf", archive.archivePath, "-C", destDir]);
  }
}

async function extractArchiveAsync(
  archive: ArchiveInfo,
  destDir: string,
): Promise<void> {
  if (archive.format === "7z") {
    const bundled = resolveBundled7zaPath();
    if (!bundled) {
      throw new Error(
        "No bundled 7za binary found to extract payload.7z. " +
          "Expected at resources/bin/7za.exe (Windows) or resources/bin/7za.",
      );
    }
    await execFileAsync(bundled, [
      "x",
      archive.archivePath,
      `-o${destDir}`,
      "-bd",
      "-y",
    ]);
    return;
  }
  if (archive.format === "tar.gz") {
    await execFileAsync("tar", ["-xzf", archive.archivePath, "-C", destDir]);
  } else {
    await execFileAsync("tar", ["-xf", archive.archivePath, "-C", destDir]);
  }
}

/**
 * Resolve the openclaw sidecar root path WITHOUT extracting.
 * Returns the path where the sidecar will live after extraction.
 * Used by createRuntimeUnitManifests to set up paths early without
 * blocking the main process on synchronous tar extraction.
 */
export function resolveOpenclawSidecarRoot(
  runtimeSidecarBaseRoot: string,
  runtimeRoot: string,
): string {
  const packagedSidecarRoot = path.resolve(runtimeSidecarBaseRoot, "openclaw");
  const archive = resolvePayloadArchive(packagedSidecarRoot);
  if (!archive) {
    return packagedSidecarRoot;
  }
  return path.resolve(runtimeRoot, "openclaw-sidecar");
}

export function ensurePackagedOpenclawSidecar(
  runtimeSidecarBaseRoot: string,
  runtimeRoot: string,
): string {
  const packagedSidecarRoot = path.resolve(runtimeSidecarBaseRoot, "openclaw");
  const archive = resolvePayloadArchive(packagedSidecarRoot);

  if (!archive) {
    return packagedSidecarRoot;
  }

  const extractedSidecarRoot = ensureDir(
    path.resolve(runtimeRoot, "openclaw-sidecar"),
  );
  const stampPath = path.resolve(extractedSidecarRoot, ".archive-stamp");
  const archiveStamp = resolveArchiveStamp(packagedSidecarRoot, archive);
  const extractedOpenclawEntry = path.resolve(
    extractedSidecarRoot,
    "node_modules/openclaw/openclaw.mjs",
  );

  if (
    existsSync(stampPath) &&
    existsSync(extractedOpenclawEntry) &&
    readFileSync(stampPath, "utf8") === archiveStamp
  ) {
    // Run lift on every boot so users upgrading from a pre-lift build
    // pick up the workaround without re-extracting. Idempotent.
    liftBundledExtensionDepsSync(extractedSidecarRoot);
    return extractedSidecarRoot;
  }

  const stagingRoot = `${extractedSidecarRoot}.staging`;
  const MAX_RETRIES = 3;

  removeDirectorySync(stagingRoot);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      removeDirectorySync(stagingRoot);
      mkdirSync(stagingRoot, { recursive: true });
      extractArchiveSync(archive, stagingRoot);

      const stagingEntry = path.resolve(
        stagingRoot,
        "node_modules/openclaw/openclaw.mjs",
      );
      if (!existsSync(stagingEntry)) {
        throw new Error(
          `Extraction verification failed: ${stagingEntry} not found`,
        );
      }

      writeFileSync(path.resolve(stagingRoot, ".archive-stamp"), archiveStamp);

      removeDirectorySync(extractedSidecarRoot);
      robustRenameSync(stagingRoot, extractedSidecarRoot);
      liftBundledExtensionDepsSync(extractedSidecarRoot);
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      const waitMs = 1000;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        /* busy-wait for sync context */
      }
    }
  }

  return extractedSidecarRoot;
}

/**
 * Check if the packaged openclaw sidecar archive needs extraction.
 * Fast, synchronous, filesystem-read-only.
 */
export function checkOpenclawExtractionNeeded(
  electronRoot: string,
  userDataPath: string,
  isPackaged: boolean,
): boolean {
  if (!isPackaged) return false;

  const runtimeSidecarBaseRoot = path.resolve(electronRoot, "runtime");
  const runtimeRoot = path.resolve(userDataPath, "runtime");
  const packagedSidecarRoot = path.resolve(runtimeSidecarBaseRoot, "openclaw");
  const archive = resolvePayloadArchive(packagedSidecarRoot);

  if (!archive) return false;

  const extractedSidecarRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
  const stampPath = path.resolve(extractedSidecarRoot, ".archive-stamp");
  const extractedEntry = path.resolve(
    extractedSidecarRoot,
    "node_modules/openclaw/openclaw.mjs",
  );

  try {
    const archiveStamp = resolveArchiveStamp(packagedSidecarRoot, archive);
    return !(
      existsSync(stampPath) &&
      existsSync(extractedEntry) &&
      readFileSync(stampPath, "utf8") === archiveStamp
    );
  } catch {
    return true;
  }
}

/**
 * Extract the openclaw sidecar archive asynchronously with retries.
 * Uses staging dir + atomic rename to prevent half-extracted directories.
 * Must be called before the controller unit starts.
 */
export async function extractOpenclawSidecarAsync(
  electronRoot: string,
  userDataPath: string,
): Promise<void> {
  const runtimeSidecarBaseRoot = path.resolve(electronRoot, "runtime");
  const runtimeRoot = path.resolve(userDataPath, "runtime");
  const packagedSidecarRoot = path.resolve(runtimeSidecarBaseRoot, "openclaw");
  const archive = resolvePayloadArchive(packagedSidecarRoot);

  if (!archive) {
    const packagedEntry = path.resolve(
      packagedSidecarRoot,
      "node_modules/openclaw/openclaw.mjs",
    );
    if (existsSync(packagedEntry)) {
      liftBundledExtensionDepsSync(packagedSidecarRoot);
      return;
    }

    throw new Error(
      `No payload archive found in ${packagedSidecarRoot} ` +
        "(expected payload.7z, payload.tar.gz, or payload.zip)",
    );
  }

  const extractedSidecarRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
  const archiveStamp = resolveArchiveStamp(packagedSidecarRoot, archive);
  const stampPath = path.resolve(extractedSidecarRoot, ".archive-stamp");
  const extractedEntry = path.resolve(
    extractedSidecarRoot,
    "node_modules/openclaw/openclaw.mjs",
  );

  // Fast path: archive already extracted and stamp matches. Still run
  // the lift step because a prior extraction from a pre-lift build may
  // have left extension deps un-lifted. Idempotent.
  if (
    existsSync(stampPath) &&
    existsSync(extractedEntry) &&
    readFileSync(stampPath, "utf8") === archiveStamp
  ) {
    liftBundledExtensionDepsSync(extractedSidecarRoot);
    return;
  }

  const stagingRoot = `${extractedSidecarRoot}.staging`;

  await removeDirectoryAsync(stagingRoot);

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await removeDirectoryAsync(stagingRoot);
      mkdirSync(stagingRoot, { recursive: true });
      await extractArchiveAsync(archive, stagingRoot);

      const stagingEntry = path.resolve(
        stagingRoot,
        "node_modules/openclaw/openclaw.mjs",
      );
      if (!existsSync(stagingEntry)) {
        throw new Error(
          `Extraction verification failed: ${stagingEntry} not found`,
        );
      }

      writeFileSync(path.resolve(stagingRoot, ".archive-stamp"), archiveStamp);

      await removeDirectoryAsync(extractedSidecarRoot);
      await robustRenameAsync(stagingRoot, extractedSidecarRoot);
      liftBundledExtensionDepsSync(extractedSidecarRoot);
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export function createRuntimeUnitManifests(
  electronRoot: string,
  userDataPath: string,
  isPackaged: boolean,
  runtimeConfig: DesktopRuntimeConfig,
): RuntimeUnitManifest[] {
  const repoRoot = getWorkspaceRoot();
  const _nexuRoot = repoRoot;
  const runtimeSidecarBaseRoot = isPackaged
    ? path.resolve(electronRoot, "runtime")
    : path.resolve(repoRoot, ".tmp/sidecars");
  const runtimeRoot = ensureDir(path.resolve(userDataPath, "runtime"));
  // Use the non-blocking path resolver for manifest creation. Actual
  // extraction happens later in extractOpenclawSidecarAsync() during
  // cold start. This avoids blocking the main process for 10-20s on
  // first install while tar extracts synchronously.
  const openclawSidecarRoot = isPackaged
    ? resolveOpenclawSidecarRoot(runtimeSidecarBaseRoot, runtimeRoot)
    : path.resolve(runtimeSidecarBaseRoot, "openclaw");
  const logsDir = ensureDir(path.resolve(userDataPath, "logs/runtime-units"));
  const openclawRuntimeRoot = ensureDir(path.resolve(runtimeRoot, "openclaw"));
  const openclawConfigDir = ensureDir(
    path.resolve(openclawRuntimeRoot, "config"),
  );
  const openclawStateDir = ensureDir(
    path.resolve(openclawRuntimeRoot, "state"),
  );
  const openclawTempDir = ensureDir(path.resolve(openclawRuntimeRoot, "tmp"));
  const openclawSkillsDir = ensureDir(
    isPackaged
      ? getOpenclawSkillsDir(userDataPath)
      : path.resolve(openclawStateDir, "skills"),
  );
  ensureDir(path.resolve(openclawStateDir, "plugin-docs"));
  ensureDir(path.resolve(openclawStateDir, "agents"));
  const openclawPackageRoot = path.resolve(
    openclawSidecarRoot,
    "node_modules/openclaw",
  );
  const controllerSidecarRoot = path.resolve(
    runtimeSidecarBaseRoot,
    "controller",
  );
  const controllerModulePath = path.resolve(
    controllerSidecarRoot,
    "dist/index.js",
  );
  const webSidecarRoot = path.resolve(runtimeSidecarBaseRoot, "web");
  const webModulePath = path.resolve(webSidecarRoot, "index.js");
  const openclawBinPath =
    process.env.NEXU_OPENCLAW_BIN ??
    path.resolve(
      openclawSidecarRoot,
      process.platform === "win32" ? "bin/openclaw.cmd" : "bin/openclaw",
    );
  const controllerPort = runtimeConfig.ports.controller;
  const webPort = runtimeConfig.ports.web;
  const webUrl = runtimeConfig.urls.web;
  const electronNodeRunner = resolveElectronNodeRunner(isPackaged);
  const openclawNodePath = buildOpenclawNodePath(openclawSidecarRoot);
  const skillNodePath = buildSkillNodePath(electronRoot, isPackaged);
  const childProcessProxyEnv = buildChildProcessProxyEnv(runtimeConfig.proxy);

  // Keep all default ports and local URLs defined from this one manifest factory. Other desktop
  // entry points still mirror a few of these defaults directly, so changes here should be treated
  // as contract changes until those call sites are centralized.

  return [
    {
      id: "web",
      label: "nexu Web Surface",
      kind: "surface",
      launchStrategy: "managed",
      runner: "spawn",
      command: electronNodeRunner,
      args: [webModulePath],
      cwd: webSidecarRoot,
      port: webPort,
      startupTimeoutMs: 10_000,
      autoStart: true,
      logFilePath: path.resolve(logsDir, "web.log"),
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        WEB_HOST: "127.0.0.1",
        WEB_PORT: String(webPort),
        WEB_API_ORIGIN: runtimeConfig.urls.controllerBase,
        ...childProcessProxyEnv,
      },
    },
    {
      id: "control-plane",
      label: "Desktop Control Plane",
      kind: "surface",
      launchStrategy: "embedded",
      port: null,
      autoStart: true,
      logFilePath: path.resolve(logsDir, "control-plane.log"),
    },
    {
      id: "controller",
      label: "nexu Controller",
      kind: "service",
      launchStrategy: "managed",
      // Use spawn instead of utility-process due to Electron bugs:
      // - https://github.com/electron/electron/issues/43186
      //   Network requests fail with ECONNRESET after event loop blocking
      // - https://github.com/electron/electron/issues/44727
      //   Utility process uses hidden network context, not session.defaultSession
      runner: "spawn",
      command: electronNodeRunner,
      args: [controllerModulePath],
      cwd: controllerSidecarRoot,
      port: controllerPort,
      startupTimeoutMs: 60_000,
      autoStart: getBooleanEnv("NEXU_DESKTOP_AUTOSTART_CONTROLLER", true),
      logFilePath: path.resolve(logsDir, "controller.log"),
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        FORCE_COLOR: "1",
        PORT: String(controllerPort),
        HOST: "127.0.0.1",
        WEB_URL: webUrl,
        NEXU_HOME: runtimeConfig.paths.nexuHome,
        OPENCLAW_STATE_DIR: openclawStateDir,
        OPENCLAW_CONFIG_PATH: path.resolve(openclawConfigDir, "openclaw.json"),
        OPENCLAW_SKILLS_DIR: openclawSkillsDir,
        SKILLHUB_STATIC_SKILLS_DIR: isPackaged
          ? path.resolve(electronRoot, "static/bundled-skills")
          : path.resolve(repoRoot, "apps/desktop/static/bundled-skills"),
        PLATFORM_TEMPLATES_DIR: isPackaged
          ? path.resolve(electronRoot, "static/platform-templates")
          : path.resolve(repoRoot, "apps/controller/static/platform-templates"),
        OPENCLAW_BIN: openclawBinPath,
        ...(isPackaged
          ? { OPENCLAW_ELECTRON_EXECUTABLE: process.execPath }
          : {}),
        OPENCLAW_EXTENSIONS_DIR: path.resolve(
          openclawPackageRoot,
          "dist/extensions",
        ),
        OPENCLAW_GATEWAY_PORT: String(
          new URL(runtimeConfig.urls.openclawBase).port || 18789,
        ),
        OPENCLAW_GATEWAY_TOKEN: runtimeConfig.tokens.gateway,
        NODE_PATH: skillNodePath,
        NODE_OPTIONS: [
          "--disable-warning=ExperimentalWarning",
          process.env.NODE_OPTIONS,
        ]
          .filter(Boolean)
          .join(" "),
        OPENCLAW_NODE_OPTIONS_READY: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        TMPDIR: openclawTempDir,
        RUNTIME_MANAGE_OPENCLAW_PROCESS: "true",
        RUNTIME_GATEWAY_PROBE_ENABLED: "false",
        ...(openclawNodePath ? { PATH: openclawNodePath } : {}),
        ...childProcessProxyEnv,
      },
    },
    {
      id: "openclaw",
      label: "OpenClaw Runtime",
      kind: "runtime",
      launchStrategy: "delegated",
      delegatedProcessMatch: "openclaw-gateway",
      binaryPath: openclawBinPath,
      port: null,
      autoStart: true,
      logFilePath: path.resolve(logsDir, "openclaw.log"),
    },
  ];
}
