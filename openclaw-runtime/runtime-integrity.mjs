import path from "node:path";
import { exists } from "./utils.mjs";

export const criticalRuntimeFiles = [
  path.join("node_modules", "openclaw", "dist"),
  path.join("node_modules", "openclaw", "package.json"),
  path.join("node_modules", "chalk", "package.json"),
  path.join("node_modules", "chalk", "source", "index.js"),
  path.join("node_modules", "tslog", "package.json"),
  path.join("node_modules", "tslog", "esm", "index.js"),
];

export async function findMissingRuntimeFiles(runtimeDir) {
  const missing = [];
  for (const relativePath of criticalRuntimeFiles) {
    if (!(await exists(path.join(runtimeDir, relativePath)))) {
      missing.push(relativePath);
    }
  }
  return missing;
}

export async function hasCompleteRuntimeInstall(runtimeDir) {
  return (await findMissingRuntimeFiles(runtimeDir)).length === 0;
}
