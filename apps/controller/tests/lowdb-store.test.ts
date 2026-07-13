import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LowDbStore } from "../src/store/lowdb-store.js";

const schema = z.object({
  count: z.number(),
  label: z.string().optional(),
});

describe("LowDbStore", () => {
  const rootDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      rootDirs.splice(0).map((rootDir) =>
        rm(rootDir, { recursive: true, force: true }),
      ),
    );
  });

  async function createStore(): Promise<{
    filePath: string;
    store: LowDbStore<z.infer<typeof schema>>;
  }> {
    const rootDir = await mkdtemp(path.join(tmpdir(), "clawpi-lowdb-"));
    rootDirs.push(rootDir);
    const filePath = path.join(rootDir, "config.json");
    return {
      filePath,
      store: new LowDbStore(filePath, schema, () => ({ count: 0 })),
    };
  }

  it("writes config through a temporary file and backup", async () => {
    const { filePath, store } = await createStore();

    await store.write({ count: 7, label: "saved" });

    await expect(readFile(filePath, "utf8")).resolves.toContain(
      '"label": "saved"',
    );
    await expect(readFile(`${filePath}.bak`, "utf8")).resolves.toContain(
      '"count": 7',
    );
    await expect(store.read()).resolves.toEqual({ count: 7, label: "saved" });
  });

  it("removes stale write locks before saving", async () => {
    const { filePath, store } = await createStore();
    const lockPath = `${filePath}.lock`;
    const staleTime = new Date(Date.now() - 35_000);
    await writeFile(lockPath, "stale", "utf8");
    await utimes(lockPath, staleTime, staleTime);

    await store.write({ count: 3 });

    await expect(readFile(filePath, "utf8")).resolves.toContain('"count": 3');
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes concurrent writes without sharing a fixed temp path", async () => {
    const { filePath, store } = await createStore();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.write({
          count: index,
          label: `write-${index}`,
        }),
      ),
    );

    const stored = JSON.parse(await readFile(filePath, "utf8")) as {
      count: number;
      label: string;
    };
    expect(stored).toEqual({ count: 4, label: "write-4" });

    const leftoverFiles = await readdir(path.dirname(filePath));
    expect(leftoverFiles.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
