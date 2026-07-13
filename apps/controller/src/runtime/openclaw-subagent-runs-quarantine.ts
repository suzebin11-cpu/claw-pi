import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger.js";

const DEFAULT_RETAIN_BACKUPS = 5;
const BACKUP_PREFIX = "runs.startup-quarantine-";
const BACKUP_SUFFIX = ".json";
// `{ version: 2, runs: {} }` parses cleanly under OpenClaw's
// REGISTRY_VERSION === 2 schema (subagent-registry-state-DxN2JqM0.js) and
// produces a zero-entry Map, which short-circuits restoreSubagentRunsOnce
// before it can touch the cleanup / announce / loader chain.
const EMPTY_RUNS_PAYLOAD = `${JSON.stringify(
  { version: 2, runs: {} },
  null,
  2,
)}\n`;

export interface QuarantineOptions {
  stateDir: string;
  /** Number of backups to retain alongside the active runs.json. */
  retainBackups?: number;
  /** Injectable clock so tests get deterministic backup file names. */
  now?: () => Date;
}

export type QuarantineSkipReason =
  | "absent"
  | "already-empty"
  | "directory-missing"
  | "io-error";

export interface QuarantineResult {
  quarantined: boolean;
  reason?: QuarantineSkipReason;
  backupPath?: string;
  removedBackups: string[];
  originalRunCount?: number;
}

/**
 * Quarantine the OpenClaw sidecar's persisted subagent registry before
 * (re)spawning the sidecar.
 *
 * On gateway start, OpenClaw calls `initSubagentRegistry()` which restores
 * any persisted entries from `<stateDir>/subagents/runs.json` and then
 * iterates them through `resumeSubagentRun` -> announce / cleanup. Each
 * pass calls `ensureSubagentRegistryPluginRuntimeLoaded`, which on cacheKey
 * miss triggers `loadOpenClawPlugins` and re-registers every channel
 * plugin (`setWeixinRuntime`, `Registered <channel> tool`, ...). With N
 * stale runs * up to 3 announce retries each, this manifests as the
 * ~45 back-to-back plugin re-registration bursts seen on the affected
 * user's machine, stalling the sidecar event loop for 2-4 minutes after
 * every (re)start.
 *
 * The recovery loop and REGISTRY_VERSION schema both live in
 * `node_modules/openclaw`, so we can't fix it upstream. Replacing the
 * persisted runs file with an empty (but schema-valid) registry *before*
 * spawn cuts the chain at its source.
 *
 * The previous file is preserved as
 * `runs.startup-quarantine-<UTC-timestamp>.json` next to the active
 * registry for postmortem inspection. Old backups beyond `retainBackups`
 * (newest-first, default 5) are pruned.
 *
 * Cost: subagent runs that were mid-cleanup at the previous shutdown lose
 * their final announce / cleanup pass. OpenClaw itself already gives up
 * on those after 5 minutes (`pi-embedded.js`: `Date.now() - entry.endedAt
 * > 3e5`), so the marginal loss is bounded to runs that ended within the
 * 5 minutes preceding shutdown — small relative to the multi-minute
 * event-loop stalls this prevents.
 *
 * Errors are swallowed and logged: this hook MUST NEVER block sidecar
 * startup, even if disk I/O misbehaves.
 */
export function quarantineSubagentRunsForStartupSync(
  opts: QuarantineOptions,
): QuarantineResult {
  const stateDir = opts.stateDir;
  const retainBackups = opts.retainBackups ?? DEFAULT_RETAIN_BACKUPS;
  const now = opts.now?.() ?? new Date();

  const subagentsDir = path.join(stateDir, "subagents");
  const runsPath = path.join(subagentsDir, "runs.json");

  if (!directoryExists(subagentsDir)) {
    return {
      quarantined: false,
      reason: "directory-missing",
      removedBackups: [],
    };
  }

  let raw: string | null = null;
  try {
    raw = readFileSync(runsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { quarantined: false, reason: "absent", removedBackups: [] };
    }
    logger.warn(
      { error: (err as Error).message, runsPath },
      "subagent_runs_quarantine_read_failed",
    );
    return { quarantined: false, reason: "io-error", removedBackups: [] };
  }

  let parsed: unknown;
  let parseable = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parseable = false;
    parsed = null;
  }

  const runCount = countRuns(parsed);
  if (parseable && runCount === 0) {
    // Empty registry already; sidecar restore would short-circuit on its own.
    return {
      quarantined: false,
      reason: "already-empty",
      removedBackups: [],
    };
  }

  const stamp = formatStamp(now);
  const backupPath = path.join(
    subagentsDir,
    `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`,
  );

  try {
    atomicWriteSync(backupPath, raw);
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, backupPath },
      "subagent_runs_quarantine_backup_failed",
    );
    return { quarantined: false, reason: "io-error", removedBackups: [] };
  }

  try {
    atomicWriteSync(runsPath, EMPTY_RUNS_PAYLOAD);
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, runsPath },
      "subagent_runs_quarantine_replace_failed",
    );
    return {
      quarantined: false,
      reason: "io-error",
      backupPath,
      removedBackups: [],
    };
  }

  const removedBackups = pruneOldBackupsSync(subagentsDir, retainBackups);

  logger.warn(
    {
      runsPath,
      backupPath,
      originalRunCount: runCount,
      removedBackups,
      parseable,
    },
    "subagent_runs_startup_quarantined",
  );

  return {
    quarantined: true,
    backupPath,
    removedBackups,
    originalRunCount: runCount,
  };
}

/**
 * Async wrapper for callers (e.g. controller bootstrap, channel-service
 * launchctl path) that already live in async contexts. The work is fully
 * synchronous I/O; this just removes the need for callers to know about
 * the sync entrypoint.
 */
export function quarantineSubagentRunsForStartup(
  opts: QuarantineOptions,
): Promise<QuarantineResult> {
  return Promise.resolve(quarantineSubagentRunsForStartupSync(opts));
}

function directoryExists(target: string): boolean {
  try {
    const stat = statSync(target);
    return stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    logger.warn(
      { error: (err as Error).message, target },
      "subagent_runs_quarantine_stat_failed",
    );
    return false;
  }
}

function countRuns(parsed: unknown): number {
  if (!parsed || typeof parsed !== "object") {
    return 0;
  }
  const record = parsed as { runs?: unknown };
  if (!record.runs || typeof record.runs !== "object") {
    return 0;
  }
  return Object.keys(record.runs as Record<string, unknown>).length;
}

function atomicWriteSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  writeFileSync(tmp, content, { encoding: "utf8" });
  // POSIX rename is atomic; Node 22+ on Windows uses MoveFileExW with
  // MOVEFILE_REPLACE_EXISTING so existing targets are overwritten.
  renameSync(tmp, targetPath);
}

function pruneOldBackupsSync(subagentsDir: string, retain: number): string[] {
  if (retain < 0) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return [];
  }

  const backups: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) {
      continue;
    }
    try {
      const stat = statSync(path.join(subagentsDir, name));
      backups.push({ name, mtimeMs: stat.mtimeMs });
    } catch {
      // skip entries that vanished between readdir and stat
    }
  }

  if (backups.length <= retain) {
    return [];
  }

  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toRemove = backups.slice(retain);
  const removed: string[] = [];
  for (const entry of toRemove) {
    const target = path.join(subagentsDir, entry.name);
    try {
      rmSync(target, { force: true });
      removed.push(entry.name);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, target },
        "subagent_runs_quarantine_prune_failed",
      );
    }
  }
  return removed;
}

function formatStamp(now: Date): string {
  // ISO 8601 with ':' / '.' replaced so the file name is valid on Windows.
  return now.toISOString().replace(/[:.]/g, "-");
}
