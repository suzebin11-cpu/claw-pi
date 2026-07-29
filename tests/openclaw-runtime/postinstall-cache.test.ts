import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheInputs,
  computeFingerprint,
} from "../../openclaw-runtime/postinstall-cache.mjs";
import {
  criticalRuntimeFiles,
  findMissingRuntimeFiles,
  hasCompleteRuntimeInstall,
} from "../../openclaw-runtime/runtime-integrity.mjs";

const tempDirs = [] as string[];

async function createRuntimeFixture() {
  const runtimeDir = await mkdtemp(
    path.join(tmpdir(), "openclaw-runtime-cache-"),
  );
  tempDirs.push(runtimeDir);

  for (const relativePath of cacheInputs) {
    const absolutePath = path.join(runtimeDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${relativePath}\n`, "utf8");
  }

  await mkdir(path.join(runtimeDir, "node_modules"), { recursive: true });
  await writeFile(path.join(runtimeDir, "README.md"), "docs v1\n", "utf8");

  return runtimeDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("openclaw-runtime postinstall cache fingerprint", () => {
  it("ignores docs-only changes outside cache inputs", async () => {
    const runtimeDir = await createRuntimeFixture();
    const before = await computeFingerprint(runtimeDir);

    await writeFile(path.join(runtimeDir, "README.md"), "docs v2\n", "utf8");

    const after = await computeFingerprint(runtimeDir);
    expect(after).toBe(before);
  });

  it("changes when a tracked install input changes", async () => {
    const runtimeDir = await createRuntimeFixture();
    const before = await computeFingerprint(runtimeDir);

    await writeFile(
      path.join(runtimeDir, "prune-runtime-paths.mjs"),
      "export const pruneTargets = ['node_modules/foo'];\n",
      "utf8",
    );

    const after = await computeFingerprint(runtimeDir);
    expect(after).not.toBe(before);
  });

  it("changes when a tracked file goes missing", async () => {
    const runtimeDir = await createRuntimeFixture();
    const before = await computeFingerprint(runtimeDir);

    await rm(path.join(runtimeDir, "postinstall.mjs"), { force: true });

    const after = await computeFingerprint(runtimeDir);
    expect(after).not.toBe(before);
  });
});

describe("openclaw-runtime integrity", () => {
  it("reports missing critical files and accepts a complete runtime", async () => {
    const runtimeDir = await mkdtemp(
      path.join(tmpdir(), "openclaw-runtime-integrity-"),
    );
    tempDirs.push(runtimeDir);

    expect(await hasCompleteRuntimeInstall(runtimeDir)).toBe(false);
    expect(await findMissingRuntimeFiles(runtimeDir)).toEqual(
      criticalRuntimeFiles,
    );

    for (const relativePath of criticalRuntimeFiles) {
      const absolutePath = path.join(runtimeDir, relativePath);
      if (path.extname(relativePath) === "") {
        await mkdir(absolutePath, { recursive: true });
      } else {
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, "fixture\n", "utf8");
      }
    }

    expect(await findMissingRuntimeFiles(runtimeDir)).toEqual([]);
    expect(await hasCompleteRuntimeInstall(runtimeDir)).toBe(true);
  });
});
