import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import * as path from "node:path";

/**
 * openclaw's packaged build places extension private deps under
 * `dist/extensions/<ext>/node_modules/<pkg>` while the main `dist/*.js`
 * chunks sometimes `require()` those same packages at the top level.
 * Node's CommonJS resolver walks upward from the requiring file and
 * never descends into a sibling extension's node_modules, so those
 * requires fail with MODULE_NOT_FOUND at runtime (breaks the dashboard
 * UI handler, which imports `@buape/carbon` transitively).
 *
 * We work around the upstream packaging bug by lifting every top-level
 * package found in any `dist/extensions/<ext>/node_modules/` into the
 * openclaw package root's own `node_modules/` via filesystem links:
 * directory junctions on Windows, symlinks elsewhere. Existing entries
 * are preserved so the operation is idempotent and safe to run after
 * every archive extraction.
 */

const LIFT_LOG_PREFIX = "[openclaw-lift]";

function log(level: "info" | "warn", message: string): void {
  const line = `${LIFT_LOG_PREFIX} ${message}`;
  if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function pathExistsIncludingBrokenLink(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function createDirLink(source: string, dest: string): void {
  const parent = path.dirname(dest);
  mkdirSync(parent, { recursive: true });
  symlinkSync(source, dest, "junction");
}

type LiftResult = {
  linked: number;
  skipped: number;
  failed: number;
};

function collectExtensionNodeModulesDirs(
  openclawPackageRoot: string,
): string[] {
  const extensionsRoot = path.resolve(openclawPackageRoot, "dist/extensions");
  if (!existsSync(extensionsRoot)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(extensionsRoot);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    const nmDir = path.resolve(extensionsRoot, entry, "node_modules");
    if (existsSync(nmDir)) {
      out.push(nmDir);
    }
  }
  return out;
}

function listTopLevelPackagesInNodeModules(
  nodeModulesDir: string,
): Array<{ name: string; sourcePath: string }> {
  const packages: Array<{ name: string; sourcePath: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(nodeModulesDir);
  } catch {
    return packages;
  }

  for (const entry of entries) {
    if (entry === ".bin" || entry === ".cache") continue;
    const entryPath = path.resolve(nodeModulesDir, entry);
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = readdirSync(entryPath);
      } catch {
        continue;
      }
      for (const inner of scoped) {
        if (inner.startsWith(".")) continue;
        packages.push({
          name: `${entry}/${inner}`,
          sourcePath: path.resolve(entryPath, inner),
        });
      }
    } else {
      packages.push({
        name: entry,
        sourcePath: entryPath,
      });
    }
  }

  return packages;
}

/**
 * Lift every package found in `openclaw/dist/extensions/*\/node_modules/`
 * into `openclaw/node_modules/` via directory junctions / symlinks. First
 * writer wins - the first extension exposing a given package becomes the
 * canonical source for subsequent resolvers. Idempotent: pre-existing
 * entries (including links left by a previous extraction cycle) are
 * respected and counted as skipped.
 */
export function liftBundledExtensionDepsSync(
  extractedSidecarRoot: string,
): LiftResult {
  const openclawPackageRoot = path.resolve(
    extractedSidecarRoot,
    "node_modules/openclaw",
  );
  const targetNodeModules = path.resolve(openclawPackageRoot, "node_modules");

  const result: LiftResult = { linked: 0, skipped: 0, failed: 0 };

  const extensionNmDirs = collectExtensionNodeModulesDirs(openclawPackageRoot);
  if (extensionNmDirs.length === 0) {
    return result;
  }

  const seen = new Set<string>();

  for (const nmDir of extensionNmDirs) {
    const packages = listTopLevelPackagesInNodeModules(nmDir);
    for (const { name, sourcePath } of packages) {
      if (seen.has(name)) {
        result.skipped++;
        continue;
      }
      seen.add(name);

      const destPath = path.resolve(targetNodeModules, ...name.split("/"));

      if (pathExistsIncludingBrokenLink(destPath)) {
        result.skipped++;
        continue;
      }

      try {
        createDirLink(sourcePath, destPath);
        result.linked++;
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        log("warn", `failed to link ${name} -> ${sourcePath}: ${message}`);
      }
    }
  }

  log(
    "info",
    `lift complete: linked=${result.linked} skipped=${result.skipped} failed=${result.failed}`,
  );

  return result;
}
