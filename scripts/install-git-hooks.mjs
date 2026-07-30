import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repoRoot, "scripts/pre-commit");
const targetPath = resolve(repoRoot, ".git/hooks/pre-commit");

try {
  await access(sourcePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);

  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755);
  }
} catch (error) {
  // Package installation must remain usable in archives and CI checkouts
  // where Git metadata or hooks are intentionally unavailable.
  console.warn(`[install-git-hooks] skipped: ${error.message}`);
}
