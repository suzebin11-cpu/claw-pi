# SkillHub Install Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the uncontrolled concurrent skill installation with a FIFO queue that handles ClawHub rate limiting, exposes queue state to the frontend, and watches the skills directory for external changes (agent-installed skills).

**Architecture:** A new `InstallQueue` class serializes all ClawHub installs (max 2 concurrent). Both curated startup installs and user-triggered installs go through the same queue. When rate-limited, the entire queue pauses using the reset duration from ClawHub's error message. A `SkillDirWatcher` monitors the skills directory for SKILL.md additions/removals by external actors (OpenClaw agent commands) and triggers ledger sync. The catalog API response is extended with queue state so the frontend can show queued/downloading status.

**Tech Stack:** Node.js native `fs.watch`, Vitest, Hono + zod-openapi, TanStack Query

---

## Background

ClawHub rate limits: 20 downloads/min (unauthenticated) or 120/min (authenticated), 60-second window. The current `CONCURRENCY=5` batch loop exhausts the limit immediately on startup. User-triggered installs during this window fail with "Rate limit exceeded". The error message format is: `Rate limit exceeded (retry in Xs, remaining: N/M, reset in Ys)`.

Additionally, the OpenClaw agent can install skills by writing directly to the skills folder, bypassing the controller. A directory watcher detects these external changes and syncs the ledger.

## Design Decisions (from brainstorming)

- **Frontend:** Show queued/downloading state on skill cards (option B)
- **Priority:** FIFO — no priority lanes, user sees a toast if queued behind curated installs
- **Concurrency:** Max 2 concurrent downloads
- **Rate-limit handling:** Queue-wide pause using parsed reset duration from error message (min 3s floor, max 60s cap), max 5 retries per item for rate-limit errors
- **Persistence:** In-memory only — curated skills re-enqueue on restart via existing logic
- **Catalog response:** Extended with `queue` array (no new endpoint)
- **Curated install trigger:** Only enqueue slugs with NO record in ledger (not on disk check). Slugs with any record (installed or uninstalled) are skipped.
- **Watcher role:** Notification trigger only — detects SKILL.md creation/deletion, code handles validation and ledger updates
- **Atomicity:** Queue writes skills to temp dir, renames to final dir. Watcher keys on SKILL.md file presence.

---

## Task 1: Add queue types to types.ts

**Files:**
- Modify: `apps/controller/src/services/skillhub/types.ts`
- Test: `apps/controller/tests/install-queue.test.ts` (created in Task 2)

**Step 1: Add types**

Add to end of `apps/controller/src/services/skillhub/types.ts`:

```typescript
export type QueueItemStatus =
  | "queued"
  | "downloading"
  | "installing-deps"
  | "done"
  | "failed";

export type QueueItem = {
  readonly slug: string;
  readonly source: SkillSource;
  readonly status: QueueItemStatus;
  readonly position: number;
  readonly error: string | null;
  readonly retries: number;
  readonly enqueuedAt: string;
};
```

**Step 2: Export from index.ts**

Add `QueueItem`, `QueueItemStatus` to `apps/controller/src/services/skillhub/index.ts` exports.

**Step 3: Verify**

Run: `pnpm typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/controller/src/services/skillhub/types.ts apps/controller/src/services/skillhub/index.ts
git commit -m "feat(skillhub): add install queue types"
```

---

## Task 2: Create InstallQueue with tests (TDD)

**Files:**
- Create: `apps/controller/src/services/skillhub/install-queue.ts`
- Create: `apps/controller/tests/install-queue.test.ts`

The InstallQueue is a FIFO queue that:
- Accepts `enqueue(slug, source)` calls from both curated and user install paths
- Deduplicates — if slug is already queued/active, returns existing item
- Runs max 2 concurrent installs via a provided `executor` function
- Parses ClawHub rate-limit errors and pauses the entire queue
- Exposes `getQueue()` for the catalog API to read
- Cleans up completed/failed items after 30 seconds

### Step 1: Write the test file

```typescript
// apps/controller/tests/install-queue.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallQueue } from "../src/services/skillhub/install-queue.js";
import type { SkillSource } from "../src/services/skillhub/types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InstallQueue", () => {
  let queue: InstallQueue;
  const noopLog = () => {};

  afterEach(() => {
    queue?.dispose();
    vi.restoreAllMocks();
  });

  // --- Enqueue & dedup ---

  it("enqueues a skill and starts executing immediately", async () => {
    const deferred = createDeferred<void>();
    const executor = vi.fn(() => deferred.promise);
    queue = new InstallQueue({ executor, log: noopLog });

    const item = queue.enqueue("weather", "managed");
    expect(item.slug).toBe("weather");
    expect(item.status).toBe("queued");

    // Allow microtask to start execution
    await Promise.resolve();
    const items = queue.getQueue();
    expect(items.some((i) => i.slug === "weather" && i.status === "downloading")).toBe(true);

    deferred.resolve();
  });

  it("deduplicates — returns existing item if slug already queued", () => {
    const executor = vi.fn(() => new Promise<void>(() => {}));
    queue = new InstallQueue({ executor, log: noopLog });

    const item1 = queue.enqueue("weather", "managed");
    const item2 = queue.enqueue("weather", "managed");
    expect(item1.slug).toBe(item2.slug);
    expect(queue.getQueue().filter((i) => i.slug === "weather")).toHaveLength(1);
  });

  // --- Concurrency limit ---

  it("respects max concurrency of 2", async () => {
    const deferreds: Deferred<void>[] = [];
    const executor = vi.fn(() => {
      const d = createDeferred<void>();
      deferreds.push(d);
      return d.promise;
    });
    queue = new InstallQueue({ executor, log: noopLog, maxConcurrency: 2 });

    queue.enqueue("a", "curated");
    queue.enqueue("b", "curated");
    queue.enqueue("c", "curated");
    await Promise.resolve();

    // Only 2 should be executing
    expect(executor).toHaveBeenCalledTimes(2);
    const items = queue.getQueue();
    const downloading = items.filter((i) => i.status === "downloading");
    const queued = items.filter((i) => i.status === "queued");
    expect(downloading).toHaveLength(2);
    expect(queued).toHaveLength(1);

    // Complete one, third should start
    deferreds[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(3);
  });

  // --- Rate limit handling ---

  it("pauses queue when rate-limited and retries after parsed delay", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const executor = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error(
          "Rate limit exceeded (retry in 2s, remaining: 0/120, reset in 2s)",
        );
      }
    });
    queue = new InstallQueue({ executor, log: noopLog, maxConcurrency: 1 });

    queue.enqueue("weather", "managed");
    await vi.advanceTimersByTimeAsync(0);

    // First attempt fails with rate limit
    expect(executor).toHaveBeenCalledTimes(1);
    const afterFail = queue.getQueue();
    expect(afterFail[0].status).toBe("queued"); // Re-queued for retry

    // Advance past the pause duration (3s floor)
    await vi.advanceTimersByTimeAsync(3000);

    // Should have retried
    expect(executor).toHaveBeenCalledTimes(2);
    const afterRetry = queue.getQueue();
    expect(afterRetry[0].status).toBe("done");

    vi.useRealTimers();
  });

  it("marks item as failed after max rate-limit retries", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => {
      throw new Error(
        "Rate limit exceeded (retry in 1s, remaining: 0/120, reset in 1s)",
      );
    });
    queue = new InstallQueue({
      executor,
      log: noopLog,
      maxConcurrency: 1,
      maxRetries: 3,
    });

    queue.enqueue("weather", "managed");

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(3000);
    }

    const items = queue.getQueue();
    const item = items.find((i) => i.slug === "weather");
    expect(item?.status).toBe("failed");
    expect(item?.retries).toBe(3);

    vi.useRealTimers();
  });

  // --- Non-rate-limit errors ---

  it("marks item as failed immediately on non-rate-limit error", async () => {
    const executor = vi.fn(async () => {
      throw new Error("ENOENT: skill not found on ClawHub");
    });
    queue = new InstallQueue({ executor, log: noopLog });

    queue.enqueue("nonexistent", "managed");
    await Promise.resolve();
    await Promise.resolve();

    const items = queue.getQueue();
    const item = items.find((i) => i.slug === "nonexistent");
    expect(item?.status).toBe("failed");
    expect(item?.error).toContain("ENOENT");
  });

  // --- Cleanup ---

  it("removes completed items after cleanup delay", async () => {
    vi.useFakeTimers();
    const executor = vi.fn(async () => {});
    queue = new InstallQueue({ executor, log: noopLog, cleanupDelayMs: 100 });

    queue.enqueue("weather", "managed");
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.getQueue().some((i) => i.slug === "weather" && i.status === "done")).toBe(true);

    await vi.advanceTimersByTimeAsync(150);
    expect(queue.getQueue().find((i) => i.slug === "weather")).toBeUndefined();

    vi.useRealTimers();
  });

  // --- Position tracking ---

  it("assigns correct positions to queued items", () => {
    const executor = vi.fn(() => new Promise<void>(() => {}));
    queue = new InstallQueue({ executor, log: noopLog, maxConcurrency: 1 });

    queue.enqueue("a", "curated");
    queue.enqueue("b", "curated");
    queue.enqueue("c", "curated");

    const items = queue.getQueue();
    expect(items.find((i) => i.slug === "a")?.position).toBe(0);
    expect(items.find((i) => i.slug === "b")?.position).toBe(1);
    expect(items.find((i) => i.slug === "c")?.position).toBe(2);
  });

  // --- Dispose ---

  it("stops processing on dispose", async () => {
    const executor = vi.fn(() => new Promise<void>(() => {}));
    queue = new InstallQueue({ executor, log: noopLog });

    queue.enqueue("weather", "managed");
    queue.dispose();

    // Should not start new items after dispose
    queue.enqueue("another", "managed");
    await Promise.resolve();
    expect(executor).toHaveBeenCalledTimes(1); // Only the first one
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- apps/controller/tests/install-queue.test.ts`
Expected: FAIL — `install-queue.js` module not found

### Step 3: Implement InstallQueue

Create `apps/controller/src/services/skillhub/install-queue.ts`:

```typescript
import type { SkillhubLogFn } from "./catalog-manager.js";
import type { QueueItem, QueueItemStatus, SkillSource } from "./types.js";

type MutableQueueItem = {
  slug: string;
  source: SkillSource;
  status: QueueItemStatus;
  error: string | null;
  retries: number;
  enqueuedAt: string;
};

export type InstallExecutor = (slug: string) => Promise<void>;

const RATE_LIMIT_PATTERN =
  /Rate limit exceeded.*?(?:retry in (\d+)s)?.*?(?:reset in (\d+)s)?/i;

const MIN_PAUSE_MS = 3000;
const MAX_PAUSE_MS = 60_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_CLEANUP_DELAY_MS = 30_000;

function parseRateLimitPauseMs(errorMessage: string): number | null {
  const match = errorMessage.match(RATE_LIMIT_PATTERN);
  if (!match) return null;

  const retrySeconds = match[1] ? Number(match[1]) : 0;
  const resetSeconds = match[2] ? Number(match[2]) : 0;
  const pauseMs = Math.max(retrySeconds, resetSeconds) * 1000;

  return Math.min(Math.max(pauseMs, MIN_PAUSE_MS), MAX_PAUSE_MS);
}

function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERN.test(message);
}

export class InstallQueue {
  private readonly pending: MutableQueueItem[] = [];
  private readonly active = new Map<string, MutableQueueItem>();
  private readonly completed: MutableQueueItem[] = [];
  private readonly executor: InstallExecutor;
  private readonly log: SkillhubLogFn;
  private readonly maxConcurrency: number;
  private readonly maxRetries: number;
  private readonly cleanupDelayMs: number;
  private pausedUntil: number = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(opts: {
    executor: InstallExecutor;
    log?: SkillhubLogFn;
    maxConcurrency?: number;
    maxRetries?: number;
    cleanupDelayMs?: number;
  }) {
    this.executor = opts.executor;
    this.log = opts.log ?? (() => {});
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.cleanupDelayMs = opts.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;
  }

  enqueue(slug: string, source: SkillSource): QueueItem {
    if (this.disposed) {
      return this.toReadonly({ slug, source, status: "failed", error: "Queue disposed", retries: 0, enqueuedAt: new Date().toISOString() }, -1);
    }

    // Dedup: check active
    const activeItem = this.active.get(slug);
    if (activeItem) return this.toReadonly(activeItem, 0);

    // Dedup: check pending
    const pendingIdx = this.pending.findIndex((i) => i.slug === slug);
    if (pendingIdx !== -1) return this.toReadonly(this.pending[pendingIdx], this.active.size + pendingIdx);

    const item: MutableQueueItem = {
      slug,
      source,
      status: "queued",
      error: null,
      retries: 0,
      enqueuedAt: new Date().toISOString(),
    };

    this.pending.push(item);
    this.log("info", `queue: enqueued ${slug} (position ${this.active.size + this.pending.length - 1})`);
    this.drain();

    return this.toReadonly(item, this.active.size + this.pending.length - 1);
  }

  getQueue(): readonly QueueItem[] {
    const result: QueueItem[] = [];
    let position = 0;

    for (const item of this.active.values()) {
      result.push(this.toReadonly(item, position++));
    }
    for (const item of this.pending) {
      result.push(this.toReadonly(item, position++));
    }
    for (const item of this.completed) {
      result.push(this.toReadonly(item, -1));
    }

    return result;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    for (const timer of this.cleanupTimers) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
  }

  private drain(): void {
    if (this.disposed) return;
    if (Date.now() < this.pausedUntil) return;

    while (this.active.size < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      item.status = "downloading";
      this.active.set(item.slug, item);
      void this.execute(item);
    }
  }

  private async execute(item: MutableQueueItem): Promise<void> {
    try {
      await this.executor(item.slug);
      item.status = "done";
      item.error = null;
      this.log("info", `queue: ${item.slug} done`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (isRateLimitError(message) && item.retries < this.maxRetries) {
        item.retries++;
        item.status = "queued";
        this.active.delete(item.slug);
        this.pending.unshift(item);

        const pauseMs = parseRateLimitPauseMs(message) ?? MIN_PAUSE_MS;
        this.pauseQueue(pauseMs);
        this.log("warn", `queue: ${item.slug} rate-limited, retry ${item.retries}/${this.maxRetries}, pausing ${pauseMs}ms`);
        return;
      }

      item.status = "failed";
      item.error = message;
      this.log("error", `queue: ${item.slug} failed: ${message}`);
    }

    this.active.delete(item.slug);
    this.completed.push(item);
    this.scheduleCleanup(item);
    this.drain();
  }

  private pauseQueue(ms: number): void {
    this.pausedUntil = Date.now() + ms;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.pausedUntil = 0;
      this.drain();
    }, ms);
  }

  private scheduleCleanup(item: MutableQueueItem): void {
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(timer);
      const idx = this.completed.indexOf(item);
      if (idx !== -1) this.completed.splice(idx, 1);
    }, this.cleanupDelayMs);
    this.cleanupTimers.add(timer);
  }

  private toReadonly(item: MutableQueueItem, position: number): QueueItem {
    return {
      slug: item.slug,
      source: item.source,
      status: item.status,
      position,
      error: item.error,
      retries: item.retries,
      enqueuedAt: item.enqueuedAt,
    };
  }
}
```

### Step 4: Export from index.ts

Add to `apps/controller/src/services/skillhub/index.ts`:
```typescript
export { InstallQueue, type InstallExecutor } from "./install-queue.js";
```

### Step 5: Run tests

Run: `pnpm test -- apps/controller/tests/install-queue.test.ts`
Expected: ALL PASS

### Step 6: Commit

```bash
git add apps/controller/src/services/skillhub/install-queue.ts apps/controller/tests/install-queue.test.ts apps/controller/src/services/skillhub/index.ts
git commit -m "feat(skillhub): add InstallQueue with rate-limit handling and tests"
```

---

## Task 3: Create SkillDirWatcher with tests (TDD)

**Files:**
- Create: `apps/controller/src/services/skillhub/skill-dir-watcher.ts`
- Create: `apps/controller/tests/skill-dir-watcher.test.ts`

The watcher monitors `skillsDir` for SKILL.md file creation/deletion. It is a notification trigger only — the actual ledger logic runs in code, not driven by events.

### Step 1: Write the test file

```typescript
// apps/controller/tests/skill-dir-watcher.test.ts
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillDb } from "../src/services/skillhub/skill-db.js";
import { SkillDirWatcher } from "../src/services/skillhub/skill-dir-watcher.js";

function makeTempDir(): string {
  const dir = resolve(tmpdir(), `skill-watcher-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(skillsDir: string, slug: string): void {
  const dir = resolve(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), `---\nname: ${slug}\n---\n`);
}

function removeSkill(skillsDir: string, slug: string): void {
  rmSync(resolve(skillsDir, slug), { recursive: true, force: true });
}

describe("SkillDirWatcher", () => {
  let tempDir: string;
  let skillsDir: string;
  let dbPath: string;
  let db: SkillDb;
  let watcher: SkillDirWatcher;
  const noopLog = () => {};

  beforeEach(async () => {
    tempDir = makeTempDir();
    skillsDir = resolve(tempDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    dbPath = resolve(tempDir, "skill-ledger.json");
    db = await SkillDb.create(dbPath);
  });

  afterEach(() => {
    watcher?.stop();
    db?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- syncNow ---

  it("syncNow records untracked on-disk skills as managed", () => {
    writeSkill(skillsDir, "agent-tool");
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });

    watcher.syncNow();

    expect(db.isInstalled("agent-tool", "managed")).toBe(true);
  });

  it("syncNow skips skills already in ledger", () => {
    writeSkill(skillsDir, "weather");
    db.recordInstall("weather", "curated");
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });

    watcher.syncNow();

    // Should still be curated, not overwritten to managed
    const all = db.getAllInstalled();
    expect(all.find((r) => r.slug === "weather")?.source).toBe("curated");
  });

  it("syncNow marks ledger-installed skills as uninstalled when missing from disk", () => {
    db.recordInstall("removed-skill", "managed");
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });

    watcher.syncNow();

    expect(db.isInstalled("removed-skill", "managed")).toBe(false);
  });

  it("syncNow is a no-op when skillsDir does not exist", () => {
    rmSync(skillsDir, { recursive: true, force: true });
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });

    // Should not throw
    watcher.syncNow();
    expect(db.getAllInstalled()).toEqual([]);
  });

  it("syncNow ignores directories without SKILL.md", () => {
    mkdirSync(resolve(skillsDir, "empty-dir"), { recursive: true });
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });

    watcher.syncNow();

    expect(db.getAllInstalled()).toEqual([]);
  });

  // --- start/stop ---

  it("start and stop do not throw", () => {
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });
    expect(() => watcher.start()).not.toThrow();
    expect(() => watcher.stop()).not.toThrow();
  });

  it("start is idempotent — calling twice does not create duplicate watchers", () => {
    watcher = new SkillDirWatcher({ skillsDir, skillDb: db, log: noopLog });
    watcher.start();
    watcher.start(); // Should not throw or create second watcher
    watcher.stop();
  });

  // --- File-system triggered sync ---

  it("detects new SKILL.md and syncs ledger after debounce", async () => {
    watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      log: noopLog,
      debounceMs: 50,
    });
    watcher.start();

    writeSkill(skillsDir, "new-agent-skill");

    // Wait for debounce + sync
    await new Promise((r) => setTimeout(r, 200));

    expect(db.isInstalled("new-agent-skill", "managed")).toBe(true);
  });

  it("detects SKILL.md removal and marks skill as uninstalled", async () => {
    writeSkill(skillsDir, "to-remove");
    db.recordInstall("to-remove", "managed");
    watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      log: noopLog,
      debounceMs: 50,
    });
    watcher.start();

    removeSkill(skillsDir, "to-remove");

    await new Promise((r) => setTimeout(r, 200));

    expect(db.isInstalled("to-remove", "managed")).toBe(false);
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm test -- apps/controller/tests/skill-dir-watcher.test.ts`
Expected: FAIL — module not found

### Step 3: Implement SkillDirWatcher

Create `apps/controller/src/services/skillhub/skill-dir-watcher.ts`:

```typescript
import { existsSync, readdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { SkillDb } from "./skill-db.js";
import type { SkillSource } from "./types.js";

export type SkillDirWatcherLogFn = (
  level: "info" | "warn" | "error",
  message: string,
) => void;

const noopLog: SkillDirWatcherLogFn = () => {};

export class SkillDirWatcher {
  private readonly skillsDir: string;
  private readonly db: SkillDb;
  private readonly log: SkillDirWatcherLogFn;
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    skillsDir: string;
    skillDb: SkillDb;
    log?: SkillDirWatcherLogFn;
    debounceMs?: number;
  }) {
    this.skillsDir = opts.skillsDir;
    this.db = opts.skillDb;
    this.log = opts.log ?? noopLog;
    this.debounceMs = opts.debounceMs ?? 500;
  }

  syncNow(): void {
    if (!this.skillsDir || !existsSync(this.skillsDir)) return;

    const diskSlugs = this.scanDiskSlugs();
    const installedRecords = this.db.getAllInstalled();
    const installedSlugs = new Set(installedRecords.map((r) => r.slug));

    // Disk has it, ledger doesn't → record as managed
    const added = diskSlugs.filter((slug) => !installedSlugs.has(slug));
    if (added.length > 0) {
      this.db.recordBulkInstall(added, "managed");
      this.log("info", `sync: recorded ${added.length} untracked skills from disk`);
    }

    // Ledger has it, disk doesn't → mark uninstalled
    const diskSlugSet = new Set(diskSlugs);
    const removedBySource = new Map<SkillSource, string[]>();
    for (const record of installedRecords) {
      if (!diskSlugSet.has(record.slug)) {
        const list = removedBySource.get(record.source) ?? [];
        list.push(record.slug);
        removedBySource.set(record.source, list);
      }
    }
    for (const [source, slugs] of removedBySource) {
      this.db.markUninstalledBySlugs(slugs, source);
    }
    const totalRemoved = Array.from(removedBySource.values()).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    if (totalRemoved > 0) {
      this.log("info", `sync: marked ${totalRemoved} missing skills as uninstalled`);
    }
  }

  start(): void {
    if (this.watcher) return;
    if (!this.skillsDir || !existsSync(this.skillsDir)) {
      this.log("warn", "watcher: skillsDir does not exist, skipping watch");
      return;
    }

    try {
      this.watcher = watch(
        this.skillsDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          if (!filename.endsWith("SKILL.md")) return;
          this.scheduleSync();
        },
      );

      this.watcher.on("error", (error) => {
        this.log("error", `watcher error: ${error.message}`);
      });

      this.log("info", `watcher: started on ${this.skillsDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("error", `watcher: failed to start: ${message}`);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.log("info", "watcher: stopped");
    }
  }

  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncNow();
    }, this.debounceMs);
  }

  private scanDiskSlugs(): string[] {
    try {
      return readdirSync(this.skillsDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(resolve(this.skillsDir, entry.name, "SKILL.md")),
        )
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}
```

### Step 4: Export from index.ts

Add to `apps/controller/src/services/skillhub/index.ts`:
```typescript
export { SkillDirWatcher, type SkillDirWatcherLogFn } from "./skill-dir-watcher.js";
```

### Step 5: Run tests

Run: `pnpm test -- apps/controller/tests/skill-dir-watcher.test.ts`
Expected: ALL PASS

### Step 6: Commit

```bash
git add apps/controller/src/services/skillhub/skill-dir-watcher.ts apps/controller/tests/skill-dir-watcher.test.ts apps/controller/src/services/skillhub/index.ts
git commit -m "feat(skillhub): add SkillDirWatcher with filesystem sync and tests"
```

---

## Task 4: Modify CatalogManager — extract installOne and wire queue

**Files:**
- Modify: `apps/controller/src/services/skillhub/catalog-manager.ts`

### Step 1: Extract `executeClawHubInstall` as a public method

Extract the clawhub install + npm deps logic from `installSkill()` into a standalone method that the queue's executor will call:

```typescript
/**
 * Execute a single clawhub install + npm deps. Does NOT record in DB.
 * Used by InstallQueue as the executor function.
 */
async executeInstall(slug: string): Promise<void> {
  const corrected = SLUG_CORRECTIONS[slug] ?? slug;
  if (!isValidSlug(corrected)) {
    throw new Error(`Invalid skill slug: ${corrected}`);
  }

  this.log("info", `installing: ${corrected} -> ${this.skillsDir}`);
  const clawHubBin = resolveClawHubBin();
  this.log("info", `install resolved clawhub=${clawHubBin}`);

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      clawHubBin,
      "--workdir",
      this.skillsDir,
      "--dir",
      ".",
      "install",
      corrected,
      "--force",
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
  if (stdout) this.log("info", `install stdout ${corrected}: ${stdout.trim()}`);
  if (stderr) this.log("warn", `install stderr ${corrected}: ${stderr.trim()}`);

  await this.installSkillDeps(resolve(this.skillsDir, corrected), corrected);
}
```

### Step 2: Simplify `installSkill()` to use queue (done in Task 5 when wiring SkillhubService)

For now, keep `installSkill()` as-is. It will be replaced in Task 5.

### Step 3: Remove the CONCURRENCY batch loop from `installCuratedSkills()`

Replace the Step 2 batch loop (lines ~354-432) with a method that just returns the list of slugs to install, letting the caller (SkillhubService) enqueue them:

```typescript
/**
 * Returns curated slugs that need installation.
 * Only returns slugs with NO record in the ledger (never seen before).
 */
getCuratedSlugsToEnqueue(): string[] {
  return CURATED_SKILL_SLUGS.filter(
    (slug) =>
      !this.db.isInstalled(slug, "curated") &&
      !this.db.isRemovedByUser(slug),
  );
}
```

Note: The original `installCuratedSkills()` method is kept for backward compatibility but the SkillhubService will stop calling it.

### Step 4: Verify

Run: `pnpm typecheck && pnpm test`
Expected: PASS

### Step 5: Commit

```bash
git add apps/controller/src/services/skillhub/catalog-manager.ts
git commit -m "refactor(skillhub): extract executeInstall and getCuratedSlugsToEnqueue from CatalogManager"
```

---

## Task 5: Wire InstallQueue and SkillDirWatcher into SkillhubService

**Files:**
- Modify: `apps/controller/src/services/skillhub-service.ts`
- Modify: `apps/controller/src/app/container.ts`
- Modify: `apps/controller/tests/skillhub-service.test.ts`

### Step 1: Rewrite SkillhubService

The service now owns the `InstallQueue` and `SkillDirWatcher`:

```typescript
import type { ControllerEnv } from "../app/env.js";
import { CatalogManager } from "./skillhub/catalog-manager.js";
import { InstallQueue } from "./skillhub/install-queue.js";
import { SkillDb } from "./skillhub/skill-db.js";
import { SkillDirWatcher } from "./skillhub/skill-dir-watcher.js";
import { copyStaticSkills, CURATED_SKILL_SLUGS } from "./skillhub/curated-skills.js";
import type { QueueItem, SkillhubCatalogData } from "./skillhub/types.js";

export class SkillhubService {
  private readonly catalogManager: CatalogManager;
  private readonly installQueue: InstallQueue;
  private readonly dirWatcher: SkillDirWatcher;
  private readonly db: SkillDb;
  private readonly env: ControllerEnv;

  private constructor(
    env: ControllerEnv,
    catalogManager: CatalogManager,
    installQueue: InstallQueue,
    dirWatcher: SkillDirWatcher,
    db: SkillDb,
  ) {
    this.env = env;
    this.catalogManager = catalogManager;
    this.installQueue = installQueue;
    this.dirWatcher = dirWatcher;
    this.db = db;
  }

  static async create(env: ControllerEnv): Promise<SkillhubService> {
    const skillDb = await SkillDb.create(env.skillDbPath);
    const log = (level: "info" | "error" | "warn", message: string) => {
      console[level === "error" ? "error" : "log"](`[skillhub] ${message}`);
    };

    const catalogManager = new CatalogManager(env.skillhubCacheDir, {
      skillsDir: env.openclawSkillsDir,
      staticSkillsDir: env.staticSkillsDir,
      skillDb,
      log,
    });

    const installQueue = new InstallQueue({
      executor: (slug) => catalogManager.executeInstall(slug),
      log,
    });

    const dirWatcher = new SkillDirWatcher({
      skillsDir: env.openclawSkillsDir,
      skillDb,
      log,
    });

    return new SkillhubService(env, catalogManager, installQueue, dirWatcher, skillDb);
  }

  start(): void {
    this.catalogManager.start();
    if (process.env.CI) return;

    // Step 1: Copy static bundled skills
    if (this.env.staticSkillsDir) {
      copyStaticSkills({
        staticDir: this.env.staticSkillsDir,
        targetDir: this.env.openclawSkillsDir,
        skillDb: this.db,
      });
    }

    // Step 2: Sync disk state with ledger
    this.dirWatcher.syncNow();

    // Step 3: Enqueue curated skills that have never been seen
    for (const slug of CURATED_SKILL_SLUGS) {
      const hasRecord =
        this.db.isInstalled(slug, "curated") ||
        this.db.isRemovedByUser(slug);
      if (!hasRecord) {
        this.installQueue.enqueue(slug, "curated");
      }
    }

    // Step 4: Start watching for external skill changes
    this.dirWatcher.start();
  }

  get catalog(): CatalogManager {
    return this.catalogManager;
  }

  get queue(): InstallQueue {
    return this.installQueue;
  }

  enqueueInstall(slug: string): QueueItem {
    return this.installQueue.enqueue(slug, "managed");
  }

  dispose(): void {
    this.dirWatcher.stop();
    this.installQueue.dispose();
    this.catalogManager.dispose();
  }
}
```

### Step 2: Update container.ts

No changes needed to `container.ts` — `SkillhubService.create(env)` signature is unchanged. The `startBackgroundLoops` already calls `skillhubService.start()`.

### Step 3: Update tests

Update `apps/controller/tests/skillhub-service.test.ts` to mock the new dependencies (`InstallQueue`, `SkillDirWatcher`) alongside existing mocks. Key test cases:
- `start()` enqueues curated slugs that have no record in DB
- `start()` skips curated slugs with existing records (installed or uninstalled)
- `start()` calls `dirWatcher.syncNow()` before enqueuing
- `start()` calls `dirWatcher.start()` after enqueuing
- `enqueueInstall()` delegates to the queue with source "managed"
- `dispose()` stops watcher and queue

### Step 4: Verify

Run: `pnpm typecheck && pnpm test`
Expected: PASS

### Step 5: Commit

```bash
git add apps/controller/src/services/skillhub-service.ts apps/controller/tests/skillhub-service.test.ts
git commit -m "feat(skillhub): wire InstallQueue and SkillDirWatcher into SkillhubService"
```

---

## Task 6: Update routes — install returns queue state, catalog includes queue

**Files:**
- Modify: `apps/controller/src/routes/skillhub-routes.ts`

### Step 1: Update install route

Change the install route to enqueue and return immediately:

```typescript
// POST /api/v1/skillhub/install
async (c) => {
  const { slug } = c.req.valid("json");
  const queueItem = container.skillhubService.enqueueInstall(slug);
  return c.json({ ok: true, queued: true, slug: queueItem.slug, status: queueItem.status }, 200);
},
```

Update the response schema to include `queued`, `slug`, `status` fields.

### Step 2: Extend catalog response with queue state

Add `queue` array to the catalog response:

```typescript
// GET /api/v1/skillhub/catalog
async (c) => {
  const catalog = container.skillhubService.catalog.getCatalog();
  const queue = container.skillhubService.queue.getQueue();
  return c.json({ ...catalog, queue }, 200);
},
```

Add `queue` to the response Zod schema:

```typescript
const queueItemSchema = z.object({
  slug: z.string(),
  source: z.enum(["curated", "managed", "custom"]),
  status: z.enum(["queued", "downloading", "installing-deps", "done", "failed"]),
  position: z.number(),
  error: z.string().nullable(),
  retries: z.number(),
  enqueuedAt: z.string(),
});
```

### Step 3: Regenerate frontend SDK

Run: `pnpm generate-types`

### Step 4: Verify

Run: `pnpm typecheck`
Expected: PASS

### Step 5: Commit

```bash
git add apps/controller/src/routes/skillhub-routes.ts apps/web/lib/api/
git commit -m "feat(skillhub): extend API with queue state in catalog and async install"
```

---

## Task 7: Update frontend — show queue state and toast

**Files:**
- Modify: `apps/web/src/hooks/use-community-catalog.ts`
- Modify: `apps/web/src/components/skills/community-skill-card.tsx`

### Step 1: Update the catalog hook

The catalog response now includes `queue`. Update the type and expose a helper:

```typescript
export function useCommunitySkills(opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await getApiV1SkillhubCatalog();
      if (error) throw new Error("Catalog fetch failed");
      return data;
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: opts?.refetchInterval,
  });
}
```

### Step 2: Update useInstallSkill to show toast

When the install returns `{ queued: true }`, show a toast notification telling the user the skill is being installed in the background. Use the existing toast/notification pattern in the codebase.

### Step 3: Update community-skill-card

Check if the skill's slug is in the `queue` array. If status is `"queued"` or `"downloading"`, show the switch in loading state. The card should poll the catalog more frequently (every 3s) while there are items in the queue.

### Step 4: Verify

Run: `pnpm typecheck`
Expected: PASS

### Step 5: Commit

```bash
git add apps/web/src/hooks/use-community-catalog.ts apps/web/src/components/skills/community-skill-card.tsx
git commit -m "feat(web): show skill queue state on cards and toast on install"
```

---

## Task 8: Update curated-skills.ts — ledger-only check

**Files:**
- Modify: `apps/controller/src/services/skillhub/curated-skills.ts`
- Modify: `apps/controller/tests/curated-skills-slugs.test.ts`

### Step 1: Simplify resolveCuratedSkillsToInstall

Change to ledger-only check (no disk check):

```typescript
export function resolveCuratedSkillsToEnqueue(params: {
  skillDb: SkillDb;
}): { toEnqueue: string[]; toSkip: string[] } {
  const toEnqueue: string[] = [];
  const toSkip: string[] = [];

  for (const slug of CURATED_SKILL_SLUGS) {
    // Any record = already handled (installed or user-removed)
    const hasRecord =
      params.skillDb.isInstalled(slug, "curated") ||
      params.skillDb.isRemovedByUser(slug);
    if (hasRecord) {
      toSkip.push(slug);
    } else {
      toEnqueue.push(slug);
    }
  }

  return { toEnqueue, toSkip };
}
```

Keep the old `resolveCuratedSkillsToInstall` for backward compat, mark as deprecated.

### Step 2: Verify

Run: `pnpm typecheck && pnpm test`
Expected: PASS

### Step 3: Commit

```bash
git add apps/controller/src/services/skillhub/curated-skills.ts apps/controller/tests/curated-skills-slugs.test.ts
git commit -m "refactor(skillhub): ledger-only check for curated skill enqueue"
```

---

## Verification Plan

This section is critical. The install queue, initialization flow, and file watcher interact in subtle ways. Each scenario below must be tested to avoid data inconsistency.

### V1: Unit Tests (automated)

Run: `pnpm test`

| Test file | What it covers |
|-----------|---------------|
| `install-queue.test.ts` | FIFO ordering, concurrency limit, rate-limit parsing, queue pause, retry, max retries → failed, dedup, cleanup, dispose |
| `skill-dir-watcher.test.ts` | syncNow: add untracked, skip existing, mark missing, no-op on missing dir, ignore dirs without SKILL.md. Watcher: detect new SKILL.md, detect removal |
| `skillhub-service.test.ts` | Startup: enqueues unseen curated, skips known, calls syncNow, starts watcher. dispose: stops watcher + queue |
| `curated-skills-slugs.test.ts` | Slug validation, no overlap between curated and static |
| `skill-db.test.ts` | CRUD, persistence, migration, source filtering |

### V2: Rate-Limit Parsing (unit test edge cases)

Test the `parseRateLimitPauseMs` function with these inputs:

| Input error message | Expected pause |
|---|---|
| `"Rate limit exceeded (retry in 1s, remaining: 0/120, reset in 1s)"` | 3000ms (floor) |
| `"Rate limit exceeded (retry in 5s, remaining: 0/120, reset in 10s)"` | 10000ms |
| `"Rate limit exceeded (retry in 120s, remaining: 0/20, reset in 120s)"` | 60000ms (cap) |
| `"Rate limit exceeded"` (no numbers) | 3000ms (default floor) |
| `"ENOENT: file not found"` | `null` (not a rate limit) |
| `"Rate limit exceeded (retry in 0s, remaining: 0/120, reset in 0s)"` | 3000ms (floor) |

### V3: Queue State Transitions (unit test)

Verify each state machine transition:

```
queued → downloading → done          (happy path)
queued → downloading → failed        (non-rate-limit error)
queued → downloading → queued        (rate-limited, retry)
queued → downloading → queued → ... → failed  (max retries exceeded)
```

Verify that `getQueue()` returns correct `position` values as items move through states.

### V4: Concurrency Invariant (unit test)

At no point should `active.size` exceed `maxConcurrency`:

```typescript
it("never exceeds max concurrency even under rapid enqueue", async () => {
  let maxActive = 0;
  let currentActive = 0;
  const executor = vi.fn(async () => {
    currentActive++;
    maxActive = Math.max(maxActive, currentActive);
    await new Promise((r) => setTimeout(r, 10));
    currentActive--;
  });
  queue = new InstallQueue({ executor, log: noopLog, maxConcurrency: 2 });

  for (let i = 0; i < 10; i++) {
    queue.enqueue(`skill-${i}`, "curated");
  }

  // Wait for all to complete
  await new Promise((r) => setTimeout(r, 200));
  expect(maxActive).toBeLessThanOrEqual(2);
});
```

### V5: Deduplication (unit test)

```typescript
it("dedup: enqueue same slug while downloading returns active item", async () => {
  // Start install, don't resolve
  // Enqueue same slug again
  // Assert only 1 executor call
  // Assert returned item has status "downloading"
});

it("dedup: enqueue same slug while queued returns pending item", () => {
  // Fill concurrency with other slugs
  // Enqueue target slug (goes to pending)
  // Enqueue same slug again
  // Assert pending has only 1 entry for that slug
});
```

### V6: Queue-Wide Pause (unit test)

```typescript
it("rate limit on one item pauses ALL pending items", async () => {
  // Item A rate-limited → queue pauses
  // Item B is pending → should NOT start during pause
  // After pause expires → both A (retry) and B start
});
```

### V7: Startup Flow — Fresh Install (integration test, manual)

Scenario: No `skill-ledger.json` exists (fresh install or app reinstall).

1. Delete `~/.nexu/skill-ledger.json` and `~/.nexu/runtime/openclaw/state/skills/*`
2. Start controller: `pnpm dev:controller`
3. **Expected logs:**
   - `[skillhub] sync: recorded 0 untracked skills from disk` (empty dir)
   - `[skillhub] queue: enqueued 1password (position 0)`
   - `[skillhub] queue: enqueued healthcheck (position 1)`
   - ... (all 21 curated slugs)
   - `[skillhub] queue: 1password done` / `queue: ... rate-limited, retry 1/5, pausing 3000ms`
4. **Verify:** After all complete, `skill-ledger.json` has records for all successfully installed skills
5. **Verify:** Skills directory has SKILL.md for each installed skill

### V8: Startup Flow — Existing User (integration test, manual)

Scenario: `skill-ledger.json` exists with records.

1. Ensure `~/.nexu/skill-ledger.json` has existing records
2. Start controller
3. **Expected:** No curated skills enqueued (all have records)
4. **Expected logs:** `[skillhub] watcher: started on ...`

### V9: Startup Flow — New Curated Skill Added (integration test, manual)

Scenario: New slug added to `CURATED_SKILL_SLUGS` after user already has a ledger.

1. Add `"test-new-skill"` to `CURATED_SKILL_SLUGS` temporarily
2. Start controller
3. **Expected:** Only `test-new-skill` is enqueued (no record in ledger)
4. **Expected:** All other curated slugs are skipped (have records)

### V10: User Install During Curated Queue (integration test, manual)

Scenario: User clicks install while curated installs are running.

1. Start fresh (delete ledger), controller starts enqueuing curated
2. While curated is running, call: `curl -X POST http://localhost:3010/api/v1/skillhub/install -H 'Content-Type: application/json' -d '{"slug":"ontology"}'`
3. **Expected:** Response: `{ "ok": true, "queued": true, "slug": "ontology", "status": "queued" }`
4. **Expected:** `ontology` appears in `GET /api/v1/skillhub/catalog` → `queue` array
5. **Expected:** Eventually installs after curated items ahead of it

### V11: Agent Installs a Skill Externally (integration test, manual)

Scenario: OpenClaw agent writes a skill directly to the skills folder.

1. Start controller with watcher running
2. Manually create: `mkdir -p ~/.nexu/runtime/openclaw/state/skills/my-agent-skill && echo '---\nname: my-agent-skill\n---' > ~/.nexu/runtime/openclaw/state/skills/my-agent-skill/SKILL.md`
3. **Expected (within 500ms + debounce):** `[skillhub] sync: recorded 1 untracked skills from disk`
4. **Expected:** `GET /api/v1/skillhub/catalog` → `installedSlugs` includes `my-agent-skill`

### V12: Agent Removes a Skill Externally (integration test, manual)

1. Start controller, ensure `my-agent-skill` is in ledger
2. `rm -rf ~/.nexu/runtime/openclaw/state/skills/my-agent-skill`
3. **Expected:** `[skillhub] sync: marked 1 missing skills as uninstalled`
4. **Expected:** `GET /api/v1/skillhub/catalog` → `installedSlugs` no longer includes `my-agent-skill`

### V13: Rate Limit Exhaustion (integration test, manual)

1. Start fresh, 21 curated skills enqueue
2. Watch logs for rate-limit messages
3. **Expected:** Queue pauses, retries, eventually all install
4. **Expected:** No skill is permanently lost — all either succeed or show as "failed" in queue
5. **Verify:** `failed` items in queue have meaningful error messages

### V14: Uninstall While Queued (edge case, unit test)

```typescript
it("uninstall removes queued item that hasn't started downloading", () => {
  // Enqueue skill, but it's behind others (position 3)
  // Call uninstallSkill() for that slug
  // Expected: item removed from pending queue
});
```

### V15: Restart During Install (manual)

1. Start controller, begin curated installs
2. Kill controller mid-install (Ctrl+C)
3. Restart controller
4. **Expected:** Curated installs re-enqueue (only those without records)
5. **Expected:** No duplicate records, no orphaned directories
6. **Verify:** `skill-ledger.json` is consistent with disk

### V16: Typecheck and Lint

Run after all tasks:
```bash
pnpm typecheck && pnpm lint && pnpm test
```
All must pass.

### V17: Frontend Verification (manual)

1. Start full stack: `pnpm dev`
2. Open `http://localhost:5173/workspace/skills`
3. Toggle a Community skill ON
4. **Expected:** Toast appears: "Installing in background..."
5. **Expected:** Switch shows loading/queued state
6. **Expected:** After install completes, switch shows ON
7. Toggle the same skill OFF
8. **Expected:** Skill uninstalls normally (no queue needed for uninstall)

### V18: Catalog Polling with Queue (manual)

1. Start fresh install (many curated queued)
2. Open skills page in browser
3. **Expected:** Cards for queued skills show downloading/queued indicators
4. **Expected:** As skills complete, cards update to installed state
5. **Expected:** Polling frequency increases while queue is active

---

## File Summary

| File | Action | Lines (est.) |
|------|--------|-------------|
| `apps/controller/src/services/skillhub/types.ts` | Modify | +10 |
| `apps/controller/src/services/skillhub/install-queue.ts` | **Create** | ~180 |
| `apps/controller/src/services/skillhub/skill-dir-watcher.ts` | **Create** | ~150 |
| `apps/controller/src/services/skillhub/catalog-manager.ts` | Modify | +30, -60 |
| `apps/controller/src/services/skillhub/curated-skills.ts` | Modify | +20 |
| `apps/controller/src/services/skillhub/index.ts` | Modify | +4 |
| `apps/controller/src/services/skillhub-service.ts` | Rewrite | ~90 |
| `apps/controller/src/routes/skillhub-routes.ts` | Modify | +15 |
| `apps/web/src/hooks/use-community-catalog.ts` | Modify | +15 |
| `apps/web/src/components/skills/community-skill-card.tsx` | Modify | +10 |
| `apps/controller/tests/install-queue.test.ts` | **Create** | ~250 |
| `apps/controller/tests/skill-dir-watcher.test.ts` | **Create** | ~120 |
| `apps/controller/tests/skillhub-service.test.ts` | Modify | ~100 |
