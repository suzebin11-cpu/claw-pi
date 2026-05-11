import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

function hasWorkspaceMarkers(path: string): boolean {
  return (
    existsSync(resolve(path, "pnpm-workspace.yaml")) ||
    (existsSync(resolve(path, "package.json")) &&
      existsSync(resolve(path, "apps")) &&
      existsSync(resolve(path, "packages")))
  );
}

function discoverWorkspaceRoot(startPath: string): string {
  let currentPath = startPath;

  while (true) {
    if (hasWorkspaceMarkers(currentPath)) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return resolve(startPath, "../../../../");
}

export function getWorkspaceRoot(): string {
  return process.env.NEXU_WORKSPACE_ROOT ?? discoverWorkspaceRoot(import.meta.dirname);
}

export function getDesktopAppRoot(): string {
  return (
    process.env.NEXU_DESKTOP_APP_ROOT ??
    resolve(getWorkspaceRoot(), "apps/desktop")
  );
}
