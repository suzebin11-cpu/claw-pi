#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const desktopPackagePath = "apps/desktop/package.json";
const releaseWorkflow = "desktop-release.yml";
const repository = "suzebin11-cpu/claw-pi";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `:\n${details.trim()}` : ""}`,
    );
  }

  return options.capture ? result.stdout.trim() : "";
}

export function parseArguments(argv) {
  const options = {
    version: "patch",
    skipChecks: false,
    wait: true,
  };

  for (const argument of argv) {
    if (argument === "--skip-checks") {
      options.skipChecks = true;
    } else if (argument === "--no-wait") {
      options.wait = false;
    } else if (argument.startsWith("--version=")) {
      options.version = argument.slice("--version=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

export function parseSemver(value) {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/,
  );
  if (!match) throw new Error(`Invalid desktop version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareVersions(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease, undefined, {
    numeric: true,
  });
}

export function resolveVersion(currentVersion, requestedVersion) {
  const current = parseSemver(currentVersion);
  if (requestedVersion === "patch") {
    return `${current.major}.${current.minor}.${current.patch + 1}`;
  }
  if (requestedVersion === "minor") {
    return `${current.major}.${current.minor + 1}.0`;
  }
  if (requestedVersion === "major") {
    return `${current.major + 1}.0.0`;
  }
  parseSemver(requestedVersion);
  if (compareVersions(requestedVersion, currentVersion) < 0) {
    throw new Error(
      `Desktop version cannot decrease: ${currentVersion} -> ${requestedVersion}`,
    );
  }
  return requestedVersion;
}

export function assertReleaseBranch(branch) {
  if (!branch || branch === "HEAD") {
    throw new Error("Desktop release requires a named local branch.");
  }
  if (branch === "main") {
    throw new Error(
      "Local main is intentionally not used by this release command. Release from the reviewed development branch, then reconcile main separately.",
    );
  }
}

function assertNoSensitiveFiles() {
  const trackedEnvFiles = run(
    "git",
    ["ls-files", ".env", ".env.*", "apps/desktop/.env", "apps/desktop/.env.*"],
    { capture: true },
  )
    .split(/\r?\n/u)
    .filter((item) => item && !item.endsWith(".example"));
  if (trackedEnvFiles.length > 0) {
    throw new Error(
      `Refusing to release tracked environment files: ${trackedEnvFiles.join(", ")}`,
    );
  }
}

async function updateDesktopVersion(nextVersion) {
  const source = await readFile(desktopPackagePath, "utf8");
  const desktopPackage = JSON.parse(source);
  desktopPackage.version = nextVersion;
  await writeFile(
    desktopPackagePath,
    `${JSON.stringify(desktopPackage, null, 2)}\n`,
    "utf8",
  );
}

function assertRemoteTagAvailable(tagName) {
  const remoteTag = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tagName}`], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (remoteTag.status === 0) {
    throw new Error(`Remote tag already exists: ${tagName}`);
  }
  if (remoteTag.status !== 2) {
    throw new Error(
      `Unable to verify remote tag availability: ${remoteTag.stderr.trim()}`,
    );
  }
}

function ensureLocalTag(tagName, commitSha) {
  const existingCommit = spawnSync(
    "git",
    ["rev-list", "-n", "1", tagName],
    {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (existingCommit.status === 0) {
    const targetCommit = existingCommit.stdout.trim();
    if (targetCommit !== commitSha) {
      throw new Error(
        `Local tag ${tagName} points to ${targetCommit}, expected ${commitSha}.`,
      );
    }
    console.log(`[release] reusing local tag ${tagName} after an interrupted push`);
    return;
  }
  if (existingCommit.status !== 128) {
    throw new Error(
      `Unable to inspect local tag ${tagName}: ${existingCommit.stderr.trim()}`,
    );
  }
  run("git", ["tag", "-a", tagName, "-m", `Claw-Pi ${tagName}`, commitSha]);
}

function waitForWorkflow(tagName) {
  console.log(`[release] waiting for GitHub Actions run for ${tagName}`);
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const runs = run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        releaseWorkflow,
        "--event",
        "push",
        "--limit",
        "20",
        "--json",
        "databaseId,headBranch,status,conclusion,url",
      ],
      { capture: true },
    );
    const matchingRun = JSON.parse(runs).find(
      (candidate) => candidate.headBranch === tagName,
    );
    if (matchingRun) {
      console.log(`[release] workflow: ${matchingRun.url}`);
      run("gh", [
        "run",
        "watch",
        String(matchingRun.databaseId),
        "--repo",
        repository,
        "--exit-status",
      ]);
      return;
    }
    if (attempt === 30) {
      throw new Error(`Timed out waiting for ${tagName} workflow to appear.`);
    }
    run("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]);
  }
}

function verifyPublishedRelease(tagName, version) {
  const release = JSON.parse(
    run(
      "gh",
      [
        "release",
        "view",
        tagName,
        "--repo",
        repository,
        "--json",
        "isDraft,isPrerelease,tagName,url,assets",
      ],
      { capture: true },
    ),
  );
  if (release.isDraft) {
    throw new Error(`GitHub Release ${tagName} is still a draft.`);
  }
  const requiredAssets = [
    `claw-pi-setup-${version}-x64.exe`,
    `claw-pi-setup-${version}-x64.exe.blockmap`,
    "latest.yml",
    "desktop-win-x64-sha256.txt",
  ];
  const assetNames = new Set(release.assets.map((asset) => asset.name));
  for (const requiredAsset of requiredAssets) {
    if (!assetNames.has(requiredAsset)) {
      throw new Error(
        `GitHub Release ${tagName} is missing ${requiredAsset}.`,
      );
    }
  }

  for (const feedUrl of [
    "https://api.clawpi.app:9443/updates/stable/win/x64",
    "https://api.clawpi.app:9443/updates/stable/x64",
  ]) {
    run("node", [
      "scripts/validate-desktop-update.mjs",
      "--feed-url",
      feedUrl,
      "--manifest-name",
      "latest.yml",
      "--version",
      version,
      "--required",
      `claw-pi-setup-${version}-x64.exe`,
      "--required",
      `claw-pi-setup-${version}-x64.exe.blockmap`,
      "--required",
      "desktop-win-x64-sha256.txt",
    ]);
  }
  console.log(`[release] published and verified: ${release.url}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  run("git", ["fetch", "--prune", "origin"]);
  run("gh", ["auth", "status"]);

  const branch = run("git", ["branch", "--show-current"], { capture: true });
  assertReleaseBranch(branch);
  assertNoSensitiveFiles();

  const desktopPackage = JSON.parse(
    await readFile(desktopPackagePath, "utf8"),
  );
  const nextVersion = resolveVersion(desktopPackage.version, options.version);
  const tagName = `v${nextVersion}`;
  assertRemoteTagAvailable(tagName);

  console.log(
    `[release] ${branch}: ${desktopPackage.version} -> ${nextVersion} (Windows OTA)`,
  );

  if (!options.skipChecks) {
    run("pnpm", ["release:desktop:check"]);
  }
  if (desktopPackage.version !== nextVersion) {
    await updateDesktopVersion(nextVersion);
  }
  run("git", ["diff", "--check"]);
  run("git", ["add", "."]);
  const staged = run("git", ["diff", "--cached", "--name-only"], {
    capture: true,
  });

  if (staged) {
    run("git", ["commit", "-m", `发布桌面端 ${tagName}`]);
  } else if (desktopPackage.version !== nextVersion) {
    throw new Error("Version update did not produce a staged source change.");
  } else {
    console.log(
      `[release] no new source changes; resuming ${tagName} from current HEAD`,
    );
  }
  const commitSha = run("git", ["rev-parse", "HEAD"], { capture: true });
  run("git", ["push", "--force", "origin", `${branch}:${branch}`]);
  ensureLocalTag(tagName, commitSha);
  run("git", ["push", "origin", `refs/tags/${tagName}`]);

  if (!options.wait) {
    console.log(`[release] source and tag pushed: ${commitSha} ${tagName}`);
    return;
  }

  waitForWorkflow(tagName);
  verifyPublishedRelease(tagName, nextVersion);
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entryPoint) {
  main().catch((error) => {
    console.error(
      `[release] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
