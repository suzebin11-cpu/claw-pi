import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getSidecarRoot,
  pathExists,
  repoRoot,
  resetDir,
} from "./lib/sidecar-paths.mjs";

const nexuRoot = repoRoot;
const controllerRoot = resolve(nexuRoot, "apps/controller");
const controllerDistRoot = resolve(controllerRoot, "dist");
const sharedRoot = resolve(nexuRoot, "packages/shared");
const sharedDistRoot = resolve(sharedRoot, "dist");
const controllerStaticRoot = resolve(controllerRoot, "static");
const controllerBundledPluginsRoot = resolve(
  controllerRoot,
  ".dist-runtime",
  "plugins",
);
const sidecarRoot = getSidecarRoot("controller");
const sidecarDistRoot = resolve(sidecarRoot, "dist");
const sidecarStaticRoot = resolve(sidecarRoot, "static");
const sidecarPluginsRoot = resolve(sidecarRoot, "plugins");
const controllerNodeModules = resolve(controllerRoot, "node_modules");
const sidecarPackageJsonPath = resolve(sidecarRoot, "package.json");

function formatDurationMs(durationMs) {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

async function ensureBuildArtifacts() {
  const missing = [];

  if (!(await pathExists(controllerDistRoot))) {
    missing.push("apps/controller/dist");
  }

  if (!(await pathExists(sharedDistRoot))) {
    missing.push("packages/shared/dist");
  }

  if (!(await pathExists(controllerNodeModules))) {
    missing.push("apps/controller/node_modules");
  }

  if (!(await pathExists(controllerBundledPluginsRoot))) {
    missing.push("apps/controller/.dist-runtime/plugins");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing controller sidecar prerequisites: ${missing.join(", ")}. Build/install nexu first.`,
    );
  }
}

async function prepareControllerSidecar() {
  const startedAt = performance.now();
  await ensureBuildArtifacts();
  await resetDir(sidecarRoot);

  await cp(controllerDistRoot, sidecarDistRoot, { recursive: true });

  if (await pathExists(controllerStaticRoot)) {
    await cp(controllerStaticRoot, sidecarStaticRoot, {
      recursive: true,
      dereference: true,
    });
  }

  if (await pathExists(controllerBundledPluginsRoot)) {
    await cp(controllerBundledPluginsRoot, sidecarPluginsRoot, {
      recursive: true,
      dereference: true,
    });
  }

  const controllerPackageJson = JSON.parse(
    await readFile(resolve(controllerRoot, "package.json"), "utf8"),
  );
  const sidecarPackageJson = {
    name: `${controllerPackageJson.name}-sidecar`,
    private: true,
    type: controllerPackageJson.type,
  };

  await writeFile(
    sidecarPackageJsonPath,
    `${JSON.stringify(sidecarPackageJson, null, 2)}\n`,
  );

  console.log(
    `[controller-sidecar][timing] prepareControllerSidecar duration=${formatDurationMs(
      performance.now() - startedAt,
    )}`,
  );
}

await prepareControllerSidecar();
