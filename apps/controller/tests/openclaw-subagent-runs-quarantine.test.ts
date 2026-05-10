import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type QuarantineResult,
  quarantineSubagentRunsForStartupSync,
} from "../src/runtime/openclaw-subagent-runs-quarantine.js";

interface RunRecord {
  status?: string;
  endedAt?: number;
}

function buildRunsPayload(runs: Record<string, RunRecord>): string {
  return JSON.stringify({ version: 2, runs }, null, 2);
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe("quarantineSubagentRunsForStartupSync", () => {
  let rootDir: string;
  let stateDir: string;
  let subagentsDir: string;
  let runsPath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-subagent-quarantine-"));
    stateDir = path.join(rootDir, "openclaw-state");
    subagentsDir = path.join(stateDir, "subagents");
    runsPath = path.join(subagentsDir, "runs.json");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("no-ops when the subagents directory does not exist yet", () => {
    const result = quarantineSubagentRunsForStartupSync({ stateDir });
    expect(result).toMatchObject<Partial<QuarantineResult>>({
      quarantined: false,
      reason: "directory-missing",
      removedBackups: [],
    });
  });

  it("no-ops when runs.json is missing inside subagents/", async () => {
    await mkdir(subagentsDir, { recursive: true });

    const result = quarantineSubagentRunsForStartupSync({ stateDir });

    expect(result).toMatchObject<Partial<QuarantineResult>>({
      quarantined: false,
      reason: "absent",
      removedBackups: [],
    });
  });

  it("no-ops when runs.json is already an empty registry", async () => {
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(runsPath, buildRunsPayload({}), "utf8");

    const result = quarantineSubagentRunsForStartupSync({ stateDir });

    expect(result).toMatchObject<Partial<QuarantineResult>>({
      quarantined: false,
      reason: "already-empty",
      removedBackups: [],
    });
    const onDisk = await readFile(runsPath, "utf8");
    expect(JSON.parse(onDisk)).toEqual({ version: 2, runs: {} });
  });

  it("backs up populated runs.json and replaces it with an empty registry", async () => {
    await mkdir(subagentsDir, { recursive: true });
    const original = buildRunsPayload({
      "run-1": { status: "ended", endedAt: 1_700_000_000_000 },
      "run-2": { status: "ended", endedAt: 1_700_000_001_000 },
      "run-3": { status: "running" },
    });
    await writeFile(runsPath, original, "utf8");

    const result = quarantineSubagentRunsForStartupSync({
      stateDir,
      now: fixedClock("2026-04-22T22:00:00.000Z"),
    });

    expect(result.quarantined).toBe(true);
    expect(result.originalRunCount).toBe(3);
    expect(result.removedBackups).toEqual([]);
    expect(result.backupPath).toMatch(
      /runs\.startup-quarantine-2026-04-22T22-00-00-000Z\.json$/,
    );

    const onDiskRuns = await readFile(runsPath, "utf8");
    expect(JSON.parse(onDiskRuns)).toEqual({ version: 2, runs: {} });

    const backupContents = await readFile(result.backupPath as string, "utf8");
    expect(backupContents).toBe(original);
    expect(path.dirname(result.backupPath as string)).toBe(subagentsDir);
  });

  it("backs up corrupted runs.json without losing the original bytes", async () => {
    await mkdir(subagentsDir, { recursive: true });
    const corrupted = "{ this is not valid json";
    await writeFile(runsPath, corrupted, "utf8");

    const result = quarantineSubagentRunsForStartupSync({
      stateDir,
      now: fixedClock("2026-04-22T22:01:00.000Z"),
    });

    expect(result.quarantined).toBe(true);
    expect(result.originalRunCount).toBe(0);
    expect(result.backupPath).toBeDefined();

    const backupContents = await readFile(result.backupPath as string, "utf8");
    expect(backupContents).toBe(corrupted);

    const onDiskRuns = await readFile(runsPath, "utf8");
    expect(JSON.parse(onDiskRuns)).toEqual({ version: 2, runs: {} });
  });

  it("uses an atomic write so no .tmp file is left behind on success", async () => {
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      runsPath,
      buildRunsPayload({ "run-1": { status: "running" } }),
      "utf8",
    );

    quarantineSubagentRunsForStartupSync({
      stateDir,
      now: fixedClock("2026-04-22T22:02:00.000Z"),
    });

    const entries = await readdir(subagentsDir);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(entries.some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("prunes oldest startup-quarantine backups beyond the retention window", async () => {
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      runsPath,
      buildRunsPayload({ "run-keep": { status: "running" } }),
      "utf8",
    );

    const existingBackups = [
      "runs.startup-quarantine-2026-04-20T10-00-00-000Z.json",
      "runs.startup-quarantine-2026-04-20T11-00-00-000Z.json",
      "runs.startup-quarantine-2026-04-20T12-00-00-000Z.json",
      "runs.startup-quarantine-2026-04-20T13-00-00-000Z.json",
    ];
    for (const [index, name] of existingBackups.entries()) {
      const target = path.join(subagentsDir, name);
      await writeFile(target, `legacy-${index}`, "utf8");
      const baseTime = new Date(`2026-04-20T${10 + index}:00:00.000Z`);
      // Ensure mtime sort is deterministic regardless of FS resolution.
      const ms = baseTime.getTime() / 1000;
      await import("node:fs/promises").then((fs) => fs.utimes(target, ms, ms));
    }

    const result = quarantineSubagentRunsForStartupSync({
      stateDir,
      retainBackups: 2,
      now: fixedClock("2026-04-22T22:03:00.000Z"),
    });

    expect(result.quarantined).toBe(true);

    const remaining = (await readdir(subagentsDir)).filter((name) =>
      name.startsWith("runs.startup-quarantine-"),
    );
    expect(remaining.sort()).toEqual(
      [
        // The freshly written backup from this invocation:
        "runs.startup-quarantine-2026-04-22T22-03-00-000Z.json",
        // Plus the newest pre-existing backup (retain=2 keeps the two newest):
        "runs.startup-quarantine-2026-04-20T13-00-00-000Z.json",
      ].sort(),
    );

    expect(result.removedBackups.sort()).toEqual(
      [
        "runs.startup-quarantine-2026-04-20T10-00-00-000Z.json",
        "runs.startup-quarantine-2026-04-20T11-00-00-000Z.json",
        "runs.startup-quarantine-2026-04-20T12-00-00-000Z.json",
      ].sort(),
    );
  });

  it("does not touch unrelated files in subagents/", async () => {
    await mkdir(subagentsDir, { recursive: true });
    const sentinelPath = path.join(subagentsDir, "do-not-touch.json");
    await writeFile(sentinelPath, '{"safe":true}', "utf8");
    await writeFile(
      runsPath,
      buildRunsPayload({ "run-1": { status: "running" } }),
      "utf8",
    );

    quarantineSubagentRunsForStartupSync({
      stateDir,
      now: fixedClock("2026-04-22T22:04:00.000Z"),
    });

    const sentinel = await readFile(sentinelPath, "utf8");
    expect(JSON.parse(sentinel)).toEqual({ safe: true });
    const sentinelStat = await stat(sentinelPath);
    expect(sentinelStat.isFile()).toBe(true);
  });
});
