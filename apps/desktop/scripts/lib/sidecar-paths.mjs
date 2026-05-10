import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const electronRoot = resolve(scriptDir, "../..");
export const repoRoot =
  process.env.NEXU_WORKSPACE_ROOT ?? resolve(electronRoot, "../..");

const runtimeSidecarRoot =
  process.env.NEXU_DESKTOP_SIDECAR_OUT_DIR ??
  resolve(repoRoot, ".tmp/sidecars");

export function getSidecarRoot(name) {
  return resolve(runtimeSidecarRoot, name);
}

export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resetDir(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export function shouldCopyRuntimeDependencies() {
  const value = process.env.NEXU_DESKTOP_COPY_RUNTIME_DEPS;
  return value === "1" || value?.toLowerCase() === "true";
}

function formatDurationMs(durationMs) {
  return `${(durationMs / 1000).toFixed(3)}s`;
}

export async function linkOrCopyDirectory(
  sourcePath,
  targetPath,
  options = {},
) {
  const excludeNames = new Set(options.excludeNames ?? []);

  if (shouldCopyRuntimeDependencies()) {
    await cp(sourcePath, targetPath, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const name = basename(source);
        return name !== ".bin" && !excludeNames.has(name);
      },
    });
    return;
  }

  if (excludeNames.size === 0) {
    await symlink(
      sourcePath,
      targetPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    return;
  }

  await mkdir(targetPath, { recursive: true });
  const entries = await readdir(sourcePath);

  for (const entry of entries) {
    if (entry === ".bin" || excludeNames.has(entry)) {
      continue;
    }

    const sourceEntryPath = resolve(sourcePath, entry);
    const sourceEntryStats = await lstat(sourceEntryPath);

    await symlink(
      sourceEntryPath,
      resolve(targetPath, entry),
      process.platform === "win32"
        ? sourceEntryStats.isDirectory()
          ? "junction"
          : "file"
        : undefined,
    );
  }
}

export async function removePathIfExists(path) {
  await rm(path, { recursive: true, force: true });
}

function getPackagePathParts(packageName) {
  return packageName.startsWith("@") ? packageName.split("/") : [packageName];
}

function getRootPackageName(packageName) {
  const packagePathParts = getPackagePathParts(packageName);
  return packagePathParts.length === 1
    ? packagePathParts[0]
    : `${packagePathParts[0]}/${packagePathParts[1]}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function resolveInstalledPackageRoot(packageRoot, packageName) {
  const requireFromPackage = createRequire(
    resolve(packageRoot, "package.json"),
  );
  let resolvedEntryPath;
  try {
    resolvedEntryPath = requireFromPackage.resolve(packageName);
  } catch {
    resolvedEntryPath = requireFromPackage.resolve(
      `${packageName}/package.json`,
    );
  }
  const rootPackageName = getRootPackageName(packageName);

  let currentPath = dirname(resolvedEntryPath);
  while (currentPath !== dirname(currentPath)) {
    const packageJsonPath = resolve(currentPath, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = await readJson(packageJsonPath);
      if (packageJson.name === rootPackageName) {
        return realpath(currentPath);
      }
    }
    currentPath = dirname(currentPath);
  }

  throw new Error(
    `Unable to locate package root for ${packageName} from ${packageRoot}.`,
  );
}

export async function copyRuntimeDependencyClosure({
  packageRoot,
  targetNodeModules,
  dependencyNames,
}) {
  const closureStartedAt = performance.now();
  let copiedPackageCount = 0;
  await mkdir(targetNodeModules, { recursive: true });

  const rootPackageJson = await readJson(resolve(packageRoot, "package.json"));
  const seen = new Set();

  // Track which (name → version) is placed at the root node_modules so we
  // can hoist transitive deps there when no version conflict exists.
  const rootSlots = new Map();

  async function copyPackageFiles(sourcePackageRoot, targetPackageRoot) {
    await mkdir(dirname(targetPackageRoot), { recursive: true });
    await rm(targetPackageRoot, { recursive: true, force: true });
    await cp(sourcePackageRoot, targetPackageRoot, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        if (basename(source) === ".bin") {
          return false;
        }

        const relativePath = relative(sourcePackageRoot, source);
        return (
          relativePath === "" ||
          (!relativePath.startsWith("node_modules/") &&
            !relativePath.startsWith("node_modules\\") &&
            relativePath !== "node_modules")
        );
      },
    });
    copiedPackageCount += 1;
  }

  async function copyDependencyTree({
    dependencyName,
    resolutionBaseRoot,
    destinationNodeModules,
  }) {
    const packagePathParts = getPackagePathParts(dependencyName);
    let sourcePackageRoot;
    try {
      sourcePackageRoot = await resolveInstalledPackageRoot(
        resolutionBaseRoot,
        dependencyName,
      );
    } catch {
      return;
    }

    const rootName = getRootPackageName(dependencyName);
    const packageJsonPath = resolve(sourcePackageRoot, "package.json");
    let packageJson;
    try {
      packageJson = await readJson(packageJsonPath);
    } catch {
      return;
    }
    const version = packageJson.version;

    // Hoisting: if this is a transitive dep (not at root level), try to
    // place it at the root node_modules to keep paths short.
    let effectiveDestination = destinationNodeModules;
    if (destinationNodeModules !== targetNodeModules) {
      const existingVersion = rootSlots.get(rootName);
      if (existingVersion === undefined) {
        rootSlots.set(rootName, version);
        effectiveDestination = targetNodeModules;
      } else if (existingVersion === version) {
        effectiveDestination = targetNodeModules;
      }
      // else: version conflict — keep nested under parent
    } else {
      rootSlots.set(rootName, version);
    }

    const targetPackageRoot = resolve(
      effectiveDestination,
      ...packagePathParts,
    );
    const seenKey = `${sourcePackageRoot}:${targetPackageRoot}`;
    if (seen.has(seenKey)) {
      return;
    }
    seen.add(seenKey);

    await copyPackageFiles(sourcePackageRoot, targetPackageRoot);

    const childDependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ];

    for (const childDependencyName of childDependencyNames) {
      await copyDependencyTree({
        dependencyName: childDependencyName,
        resolutionBaseRoot: sourcePackageRoot,
        destinationNodeModules: resolve(targetPackageRoot, "node_modules"),
      });
    }
  }

  const rootDependencyNames = [
    ...(dependencyNames ?? Object.keys(rootPackageJson.dependencies ?? {})),
    ...Object.keys(rootPackageJson.optionalDependencies ?? {}),
  ];

  for (const dependencyName of rootDependencyNames) {
    await copyDependencyTree({
      dependencyName,
      resolutionBaseRoot: packageRoot,
      destinationNodeModules: targetNodeModules,
    });
  }

  console.log(
    `[sidecar-paths][timing] copyRuntimeDependencyClosure packageRoot=${packageRoot} packages=${copiedPackageCount} duration=${formatDurationMs(
      performance.now() - closureStartedAt,
    )}`,
  );
}
