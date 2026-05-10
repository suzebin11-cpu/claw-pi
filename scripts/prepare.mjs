import { copyFile, mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const sourceHookPath = resolve(repoRoot, "scripts", "pre-commit");
const hooksDir = resolve(repoRoot, ".git", "hooks");
const targetHookPath = resolve(hooksDir, "pre-commit");

try {
  await mkdir(hooksDir, { recursive: true });
  await copyFile(sourceHookPath, targetHookPath);

  if (process.platform !== "win32") {
    await chmod(targetHookPath, 0o755);
  }
} catch (error) {
  console.warn(
    `[prepare] skipping git hook install: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
