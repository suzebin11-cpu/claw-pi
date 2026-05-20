import { randomUUID } from "node:crypto";
import {
  mkdir,
  open as openFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const WRITE_MAX_ATTEMPTS = 12;
const WRITE_RETRY_BASE_DELAY_MS = 75;
const WRITE_RETRY_MAX_DELAY_MS = 800;
const LOCK_MAX_ATTEMPTS = 80;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30_000;
const TRANSIENT_WRITE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EMFILE",
  "ENFILE",
  "EPERM",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

function isTransientWriteError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== null && TRANSIENT_WRITE_ERROR_CODES.has(code);
}

async function withTransientWriteRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWriteError(error) || attempt === WRITE_MAX_ATTEMPTS) {
        throw error;
      }

      await sleep(
        Math.min(WRITE_RETRY_BASE_DELAY_MS * attempt, WRITE_RETRY_MAX_DELAY_MS),
      );
    }
  }

  throw lastError;
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs > LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function acquireWriteLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 1; attempt <= LOCK_MAX_ATTEMPTS; attempt += 1) {
    let handle: Awaited<ReturnType<typeof openFile>> | null = null;

    try {
      handle = await openFile(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        "utf8",
      );

      return async () => {
        await handle?.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);

      if (!isTransientWriteError(error) || attempt === LOCK_MAX_ATTEMPTS) {
        throw error;
      }

      if (getErrorCode(error) === "EEXIST") {
        await removeStaleLock(lockPath);
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Timed out acquiring write lock: ${lockPath}`);
}

export class LowDbStore<T> {
  private cache: T | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly schema: { parse(input: unknown): T },
    private readonly createDefault: () => T,
  ) {}

  async read(): Promise<T> {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      this.cache = await this.readAndParse(this.filePath);
      return this.cache;
    } catch {
      const backupPath = `${this.filePath}.bak`;
      try {
        this.cache = await this.readAndParse(backupPath);
        await this.write(this.cache);
        return this.cache;
      } catch {
        const fallback = this.createDefault();
        this.cache = this.schema.parse(fallback);
        await this.write(this.cache);
        return this.cache;
      }
    }
  }

  async write(nextValue: T): Promise<void> {
    const validated = this.schema.parse(nextValue);

    const writeTask = this.writeQueue
      .catch(() => {
        // A transient Windows file-lock failure should not poison every later
        // config write until the app restarts. The caller that hit the failure
        // still receives the rejection; subsequent writes get a clean attempt.
      })
      .then(() => this.persist(validated));

    this.writeQueue = writeTask.catch(() => undefined);

    await writeTask;
  }

  async update(updater: (current: T) => T | Promise<T>): Promise<T> {
    const current = await this.read();
    const nextValue = await updater(current);
    await this.write(nextValue);
    return nextValue;
  }

  private async persist(validated: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    const backupPath = `${this.filePath}.bak`;
    const lockPath = `${this.filePath}.lock`;
    const payload = `${JSON.stringify(validated, null, 2)}\n`;
    const releaseLock = await acquireWriteLock(lockPath);

    try {
      await withTransientWriteRetry(() => writeFile(tempPath, payload, "utf8"));
      await withTransientWriteRetry(() => writeFile(backupPath, payload, "utf8"));

      try {
        await withTransientWriteRetry(() => rename(tempPath, this.filePath));
      } catch (error) {
        if (!isTransientWriteError(error)) {
          throw error;
        }

        // Some Windows machines deny atomic replacement when antivirus or
        // profile-sync software briefly holds the destination file open. The
        // backup is already durable, so a direct write is the safest fallback.
        await withTransientWriteRetry(() =>
          writeFile(this.filePath, payload, "utf8"),
        );
        await rm(tempPath, { force: true }).catch(() => undefined);
      }

      this.cache = validated;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await releaseLock();
    }
  }

  private async readAndParse(filePath: string): Promise<T> {
    const raw = await readFile(filePath, "utf8");
    return this.schema.parse(JSON.parse(raw));
  }
}
