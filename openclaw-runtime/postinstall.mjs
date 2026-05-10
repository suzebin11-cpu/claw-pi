import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeFingerprint } from "./postinstall-cache.mjs";
import { exists } from "./utils.mjs";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const nodeModulesDir = path.join(runtimeDir, "node_modules");
const cacheFileName = ".postinstall-cache.json";
const cacheFilePath = path.join(runtimeDir, cacheFileName);
const lockfilePath = path.join(runtimeDir, "package-lock.json");
const criticalRuntimeFiles = [
  path.join("node_modules", "openclaw", "dist"),
  path.join("node_modules", "@whiskeysockets", "baileys", "lib", "index.js"),
  path.join(
    "node_modules",
    "@whiskeysockets",
    "baileys",
    "WAProto",
    "index.js",
  ),
  path.join("node_modules", "@whiskeysockets", "baileys", "package.json"),
];

async function readCachedFingerprint() {
  if (!(await exists(cacheFilePath))) {
    return null;
  }

  try {
    const content = await readFile(cacheFilePath, "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

function resolveBundledNpmCli() {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(execDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  return candidates.find((candidatePath) => existsSync(candidatePath)) ?? null;
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: runtimeDir,
      stdio: "inherit",
      shell: options.shell ?? false,
      env: options.env ?? process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

function resolveGitBashPath() {
  if (process.platform !== "win32") return null;
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function buildNpmEnv() {
  const env = { ...process.env };
  const bashPath = resolveGitBashPath();
  if (bashPath && !env.npm_config_script_shell) {
    env.npm_config_script_shell = bashPath;
    console.log(
      `openclaw-runtime: using Git Bash as npm script-shell: ${bashPath}`,
    );
  }
  return env;
}

async function runNpm(args) {
  const env = buildNpmEnv();
  const bundledNpmCli = resolveBundledNpmCli();
  if (bundledNpmCli) {
    await run(process.execPath, [bundledNpmCli, ...args], { env });
    return;
  }

  await run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    shell: process.platform === "win32",
    env,
  });
}

async function installRuntime() {
  if (await exists(lockfilePath)) {
    try {
      await runNpm(["ci", "--no-audit", "--no-fund"]);
      return;
    } catch (error) {
      console.warn(
        "openclaw-runtime npm ci failed, falling back to npm install --prefer-offline.",
      );
      console.warn(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    await runNpm([
      "install",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ]);
    return;
  } catch (error) {
    console.warn(
      "openclaw-runtime npm install failed; verifying critical files before giving up.",
    );
    console.warn(error instanceof Error ? error.message : String(error));
    if (await hasCompleteRuntimeInstall()) {
      console.warn(
        "openclaw-runtime critical files are present, treating npm install exit code as non-fatal (likely a third-party postinstall script issue on Windows).",
      );
      return;
    }
    throw error;
  }
}

async function hasCompleteRuntimeInstall() {
  for (const relativePath of criticalRuntimeFiles) {
    if (!(await exists(path.join(runtimeDir, relativePath)))) {
      return false;
    }
  }
  return true;
}

try {
  const fingerprint = await computeFingerprint(runtimeDir);
  const cachedFingerprint = await readCachedFingerprint();
  const hasNodeModules = await exists(nodeModulesDir);
  const hasCompleteRuntime = hasNodeModules
    ? await hasCompleteRuntimeInstall()
    : false;

  if (
    hasNodeModules &&
    hasCompleteRuntime &&
    cachedFingerprint === fingerprint
  ) {
    console.log("openclaw-runtime unchanged, skipping install:pruned.");
    process.exit(0);
  }

  if (!hasNodeModules) {
    console.log(
      "openclaw-runtime node_modules missing, running install:pruned.",
    );
  } else if (!hasCompleteRuntime) {
    console.log(
      "openclaw-runtime critical files missing, running install:pruned.",
    );
  } else if (cachedFingerprint === null) {
    console.log("openclaw-runtime cache missing, running install:pruned.");
  } else {
    console.log("openclaw-runtime inputs changed, running install:pruned.");
  }

  await installRuntime();
  await run(process.execPath, ["./prune-runtime.mjs"]);

  await writeFile(
    cacheFilePath,
    `${JSON.stringify(
      {
        fingerprint,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("openclaw-runtime cache updated.");
} catch (error) {
  console.error("openclaw-runtime postinstall failed.");
  throw error;
}
