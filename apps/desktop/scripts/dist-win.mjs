import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(scriptDir, "..");
const repoRoot =
  process.env.NEXU_WORKSPACE_ROOT ?? resolve(electronRoot, "../..");
const desktopPackageJsonPath = resolve(electronRoot, "package.json");
const require = createRequire(import.meta.url);

const shouldReuseExistingBuildArtifacts =
  process.env.NEXU_DESKTOP_USE_EXISTING_BUILDS === "1" ||
  process.env.NEXU_DESKTOP_USE_EXISTING_BUILDS?.toLowerCase() === "true";
const shouldReuseExistingRuntimeInstall =
  process.env.NEXU_DESKTOP_USE_EXISTING_RUNTIME_INSTALL === "1" ||
  process.env.NEXU_DESKTOP_USE_EXISTING_RUNTIME_INSTALL?.toLowerCase() ===
    "true";
const isFastCiMode =
  process.env.NEXU_DESKTOP_ELECTRON_BUILDER_FAST_MODE === "1" ||
  process.env.NEXU_DESKTOP_ELECTRON_BUILDER_FAST_MODE?.toLowerCase() === "true";
const isPortableMode = process.argv.includes("--portable");

const rmWithRetriesOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

function formatDurationMs(durationMs) {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

async function timedStep(stepName, fn, timings) {
  const startedAt = performance.now();
  console.log(`[dist:win][timing] start ${stepName}`);
  try {
    return await fn();
  } finally {
    const durationMs = performance.now() - startedAt;
    timings.push({ stepName, durationMs });
    console.log(
      `[dist:win][timing] done ${stepName} duration=${formatDurationMs(durationMs)}`,
    );
  }
}

function parseEnvFile(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function getGitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveTargetWinArch() {
  const argValue = process.argv.find((arg) => arg.startsWith("--arch="));
  const rawArch =
    argValue?.slice("--arch=".length) ?? process.env.NEXU_DESKTOP_TARGET_ARCH;

  if (!rawArch) {
    return "x64";
  }
  if (rawArch === "x64") {
    return rawArch;
  }

  throw new Error(
    `[dist:win] Unsupported target arch "${rawArch}". Expected "x64".`,
  );
}

async function ensureExistingPath(targetPath, label) {
  try {
    await lstat(targetPath);
  } catch {
    throw new Error(`[dist:win] Missing ${label}: ${targetPath}`);
  }
}

async function ensureExistingBuildArtifacts() {
  await Promise.all([
    ensureExistingPath(
      resolve(repoRoot, "packages/shared/dist"),
      "shared build",
    ),
    ensureExistingPath(
      resolve(repoRoot, "apps/controller/dist"),
      "controller build",
    ),
    ensureExistingPath(resolve(repoRoot, "apps/web/dist"), "web build"),
    ensureExistingPath(resolve(electronRoot, "dist"), "desktop renderer build"),
    ensureExistingPath(
      resolve(electronRoot, "dist-electron/main"),
      "desktop main build",
    ),
    ensureExistingPath(
      resolve(electronRoot, "dist-electron/preload"),
      "desktop preload build",
    ),
  ]);
}

async function ensureExistingRuntimeInstall() {
  await Promise.all([
    ensureExistingPath(
      resolve(repoRoot, "openclaw-runtime/node_modules"),
      "openclaw-runtime install",
    ),
    ensureExistingPath(
      resolve(repoRoot, "openclaw-runtime/.postinstall-cache.json"),
      "openclaw-runtime cache",
    ),
  ]);
}

async function loadDesktopEnv() {
  const envPath = resolve(electronRoot, ".env");

  try {
    const content = await readFile(envPath, "utf8");
    return parseEnvFile(content);
  } catch {
    return {};
  }
}

function resolvePackageManagerCommand() {
  const execPath = process.env.npm_execpath?.trim();
  if (execPath) {
    return {
      command: process.execPath,
      prefixArgs: [execPath],
      shell: false,
    };
  }

  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    prefixArgs: [],
    shell: process.platform === "win32",
  };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
      shell: options.shell ?? false,
    });

    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "null"}.`,
        ),
      );
    });
  });
}

async function runPnpm(args, options = {}) {
  const packageManager = resolvePackageManagerCommand();
  await run(
    packageManager.command,
    [...packageManager.prefixArgs, ...args],
    {
      ...options,
      shell: packageManager.shell,
    },
  );
}

async function runElectronBuilder(args, options = {}) {
  const electronBuilderCli = require.resolve("electron-builder/cli.js", {
    paths: [electronRoot, repoRoot],
  });

  await run(process.execPath, [electronBuilderCli, ...args], options);
}

async function getElectronVersion() {
  const electronPackageJsonPath = require.resolve("electron/package.json", {
    paths: [electronRoot, repoRoot],
  });
  const electronPackageJson = JSON.parse(
    await readFile(electronPackageJsonPath, "utf8"),
  );

  if (typeof electronPackageJson.version !== "string") {
    throw new Error(
      `Unable to determine Electron version from ${electronPackageJsonPath}.`,
    );
  }

  return electronPackageJson.version;
}

async function ensureBuildConfig() {
  const configPath = resolve(electronRoot, "build-config.json");
  const desktopPackage = JSON.parse(
    await readFile(desktopPackageJsonPath, "utf8"),
  );
  const envPath = resolve(electronRoot, ".env");
  let fileEnv = {};

  try {
    fileEnv = parseEnvFile(await readFile(envPath, "utf8"));
  } catch {
    // .env is optional.
  }

  const merged = { ...fileEnv, ...process.env };
  const gitBranch = getGitValue(["rev-parse", "--abbrev-ref", "HEAD"]);
  const gitCommit = getGitValue(["rev-parse", "HEAD"]);

  const config = {
    NEXU_DESKTOP_UPDATE_CHANNEL:
      merged.NEXU_DESKTOP_UPDATE_CHANNEL ?? "stable",
    NEXU_DESKTOP_BUILD_SOURCE:
      merged.NEXU_DESKTOP_BUILD_SOURCE ?? "local-dist",
    ...(gitBranch
      ? {
          NEXU_DESKTOP_BUILD_BRANCH:
            merged.NEXU_DESKTOP_BUILD_BRANCH ?? gitBranch,
        }
      : {}),
    ...(gitCommit
      ? {
          NEXU_DESKTOP_BUILD_COMMIT:
            merged.NEXU_DESKTOP_BUILD_COMMIT ?? gitCommit,
        }
      : {}),
    NEXU_DESKTOP_BUILD_TIME:
      merged.NEXU_DESKTOP_BUILD_TIME ?? new Date().toISOString(),
    ...(typeof desktopPackage.version === "string"
      ? {
          NEXU_DESKTOP_APP_VERSION:
            merged.NEXU_DESKTOP_APP_VERSION ?? desktopPackage.version,
        }
      : {}),
    ...(merged.NEXU_DESKTOP_SENTRY_DSN
      ? { NEXU_DESKTOP_SENTRY_DSN: merged.NEXU_DESKTOP_SENTRY_DSN }
      : {}),
    ...(merged.NEXU_SENTRY_ENV
      ? { NEXU_SENTRY_ENV: merged.NEXU_SENTRY_ENV }
      : {}),
    CLAWPI_UPDATE_FEED_URL:
      merged.CLAWPI_UPDATE_FEED_URL ?? "https://api.claw-pi.cn/updates",
    ...(merged.NEXU_DESKTOP_AUTO_UPDATE_ENABLED
      ? {
          NEXU_DESKTOP_AUTO_UPDATE_ENABLED:
            merged.NEXU_DESKTOP_AUTO_UPDATE_ENABLED,
        }
      : {}),
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(
    "[dist:win] generated build-config.json from env:",
    JSON.stringify(config),
  );
}

async function main() {
  const timings = [];
  const targetWinArch = resolveTargetWinArch();

  if (process.platform !== "win32") {
    throw new Error(
      `[dist:win] Windows packaging must run on Windows: platform=${process.platform}, target=${targetWinArch}.`,
    );
  }

  await timedStep(
    "ensure build config",
    async () => ensureBuildConfig(),
    timings,
  );

  const desktopEnv = await loadDesktopEnv();
  const env = {
    ...process.env,
    ...desktopEnv,
    NEXU_WORKSPACE_ROOT: repoRoot,
  };
  const releaseRoot = env.NEXU_DESKTOP_RELEASE_DIR
    ? resolve(env.NEXU_DESKTOP_RELEASE_DIR)
    : resolve(electronRoot, "release");

  await timedStep(
    "clean release directories",
    async () => {
      const dirs = [releaseRoot, resolve(electronRoot, ".dist-runtime")];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
          execSync(`rmdir /s /q "${dir}"`, { stdio: "ignore", timeout: 30_000 });
        } catch {
          await rm(dir, rmWithRetriesOptions);
        }
      }
    },
    timings,
  );

  await timedStep(
    "build @nexu/shared",
    async () => {
      if (shouldReuseExistingBuildArtifacts) {
        await ensureExistingBuildArtifacts();
        console.log("[dist:win] reusing existing workspace build artifacts");
        return;
      }
      await runPnpm(
        ["--dir", repoRoot, "--filter", "@nexu/shared", "build"],
        { env },
      );
    },
    timings,
  );
  await timedStep(
    "build @nexu/controller",
    async () => {
      if (shouldReuseExistingBuildArtifacts) {
        return;
      }
      await runPnpm(
        ["--dir", repoRoot, "--filter", "@nexu/controller", "build"],
        { env },
      );
    },
    timings,
  );
  await timedStep(
    "install openclaw-runtime",
    async () => {
      if (shouldReuseExistingRuntimeInstall) {
        await ensureExistingRuntimeInstall();
        console.log("[dist:win] reusing existing openclaw-runtime install");
        return;
      }

      await run(
        process.execPath,
        [resolve(repoRoot, "openclaw-runtime", "postinstall.mjs")],
        {
          cwd: resolve(repoRoot, "openclaw-runtime"),
          env,
        },
      );
    },
    timings,
  );
  await timedStep(
    "build @nexu/web",
    async () => {
      if (shouldReuseExistingBuildArtifacts) {
        return;
      }
      await runPnpm(["--dir", repoRoot, "--filter", "@nexu/web", "build"], {
        env,
      });
    },
    timings,
  );
  await timedStep(
    "build @nexu/desktop",
    async () => {
      if (shouldReuseExistingBuildArtifacts) {
        return;
      }
      await runPnpm(["run", "build"], { cwd: electronRoot, env });
    },
    timings,
  );
  await timedStep(
    "upload sourcemaps",
    async () => {
      await run(process.execPath, [resolve(scriptDir, "upload-sourcemaps.mjs")], {
        cwd: electronRoot,
        env,
      });
    },
    timings,
  );
  await timedStep(
    "prepare runtime sidecars",
    async () => {
      await run(
        process.execPath,
        [resolve(scriptDir, "prepare-runtime-sidecars.mjs"), "--release"],
        {
          cwd: electronRoot,
          env,
        },
      );
    },
    timings,
  );

  const electronVersion = await getElectronVersion();
  const desktopPackage = JSON.parse(
    await readFile(desktopPackageJsonPath, "utf8"),
  );
  const pkgVersion = desktopPackage.version ?? "0.0.0";

  let buildVersion;
  try {
    const commitCount = execFileSync(
      "git",
      ["rev-list", "--count", "HEAD"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    buildVersion = `${pkgVersion}.${commitCount}`;
  } catch {
    buildVersion = `${pkgVersion}.0`;
  }

  const winTarget = isPortableMode ? "dir" : "nsis";

  await timedStep(
    "run electron-builder",
    async () => {
      const electronBuilderArgs = [
        "--win",
        winTarget,
        `--${targetWinArch}`,
        "--publish",
        "never",
        `--config.electronVersion=${electronVersion}`,
        `--config.buildVersion=${buildVersion}`,
        `--config.directories.output=${releaseRoot}`,
        ...(isFastCiMode
          ? ["--config.npmRebuild=false", "--config.nodeGypRebuild=false"]
          : []),
      ];

      console.log(
        `[dist:win] electron-builder mode target=${winTarget} arch=${targetWinArch} portable=${isPortableMode} fastCi=${isFastCiMode}`,
      );
      await runElectronBuilder(electronBuilderArgs, {
        cwd: electronRoot,
        env,
      });
    },
    timings,
  );

  if (isPortableMode) {
    await timedStep(
      "write portable marker",
      async () => {
        const unpackedDir = join(releaseRoot, "win-unpacked");
        await writeFile(join(unpackedDir, ".portable"), "", "utf8");
        console.log(
          `[dist:win] portable build ready at ${unpackedDir}`,
        );
      },
      timings,
    );
  }

  const totalDurationMs = timings.reduce(
    (sum, timing) => sum + timing.durationMs,
    0,
  );
  console.log("[dist:win][timing] summary");
  for (const timing of timings) {
    console.log(
      `- ${timing.stepName}: ${formatDurationMs(timing.durationMs)}`,
    );
  }
  console.log(`- total: ${formatDurationMs(totalDurationMs)}`);
}

await main();
