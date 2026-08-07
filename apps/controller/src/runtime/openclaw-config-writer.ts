import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { NEXU_INTERNAL_ACCOUNT_PREFIX } from "../lib/channel-binding-compiler.js";
import { logger } from "../lib/logger.js";
import {
  normalizeOpenClawConfig,
  openClawConfigRevision,
} from "../lib/openclaw-config-normalization.js";

export interface OpenClawConfigWriteResult {
  changed: boolean;
  revision: string;
  config: OpenClawConfig;
}

async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Sync weixin account IDs from openclaw.json to the openclaw-weixin plugin's
 * index file. The plugin reads account list from this index file, not from
 * the config, so we need to keep them in sync.
 */
async function syncWeixinAccountIndex(
  openclawStateDir: string,
  config: OpenClawConfig,
): Promise<void> {
  const weixinConfig = config.channels?.["openclaw-weixin"] as
    | { accounts?: Record<string, unknown> }
    | undefined;
  const accountIds = weixinConfig?.accounts
    ? Object.keys(weixinConfig.accounts)
    : [];

  const indexDir = path.join(openclawStateDir, "openclaw-weixin");
  const indexPath = path.join(indexDir, "accounts.json");

  // Read existing index to avoid unnecessary writes
  let existingIds: string[] = [];
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      existingIds = parsed.filter((id): id is string => typeof id === "string");
    }
  } catch {
    // File doesn't exist or is invalid
  }

  // Authoritative: config is the source of truth for which accounts are active.
  // Filter out internal prewarm IDs that should never be persisted, and only
  // keep existing IDs that are still present in the current config. Historical
  // credential/sync files are intentionally preserved so a fresh QR login can
  // reuse prior context instead of behaving like a destructive logout.
  const configIdSet = new Set(accountIds);
  const mergedIds = [
    ...new Set([
      ...existingIds.filter((id) => configIdSet.has(id)),
      ...accountIds,
    ]),
  ].filter((id) => !id.startsWith(NEXU_INTERNAL_ACCOUNT_PREFIX));

  // Only write the active account index if changed. The openclaw-weixin plugin
  // must not auto-activate accounts just because old credential files exist.
  if (JSON.stringify(mergedIds) === JSON.stringify(existingIds)) {
    return;
  }

  await mkdir(indexDir, { recursive: true });
  await writeFile(indexPath, JSON.stringify(mergedIds, null, 2), "utf8");

  logger.debug(
    { indexPath, accountIds: mergedIds },
    "weixin_account_index_synced",
  );
}

export class OpenClawConfigWriter {
  private lastWrittenRevision: string | null = null;

  constructor(private readonly env: ControllerEnv) {}

  async read(): Promise<OpenClawConfig | null> {
    try {
      return normalizeOpenClawConfig(
        JSON.parse(
          await readFile(this.env.openclawConfigPath, "utf8"),
        ) as OpenClawConfig,
      );
    } catch {
      return null;
    }
  }

  async write(config: OpenClawConfig): Promise<OpenClawConfigWriteResult> {
    await mkdir(path.dirname(this.env.openclawConfigPath), { recursive: true });
    const normalized = normalizeOpenClawConfig(config);
    const revision = openClawConfigRevision(normalized);
    const content = `${JSON.stringify(normalized, null, 2)}\n`;

    // On cold start, seed the cache from the existing file on disk so the
    // first write() after a process restart doesn't trigger an unnecessary
    // OpenClaw reload when the config hasn't actually changed.
    if (this.lastWrittenRevision === null) {
      const existing = await this.read();
      this.lastWrittenRevision = existing
        ? openClawConfigRevision(existing)
        : null;
    }

    // Skip writing if the content hasn't changed since the last write.
    // This prevents OpenClaw's file watcher from triggering unnecessary
    // reloads/restarts when syncAll() is called without actual config changes
    // (e.g. on WS reconnect after a restart).
    if (revision === this.lastWrittenRevision) {
      logger.debug(
        { path: this.env.openclawConfigPath },
        "openclaw_config_write_skipped_unchanged",
      );
      const openclawStateDir =
        this.env.openclawStateDir ?? path.dirname(this.env.openclawConfigPath);
      await syncWeixinAccountIndex(openclawStateDir, normalized);
      return { changed: false, revision, config: normalized };
    }

    const writeStartedAt = Date.now();
    logger.info(
      {
        path: this.env.openclawConfigPath,
        contentLength: content.length,
        startedAt: writeStartedAt,
      },
      "openclaw_config_write_begin",
    );
    await atomicWriteFile(this.env.openclawConfigPath, content);
    this.lastWrittenRevision = revision;

    // Sync weixin account index for openclaw-weixin plugin compatibility.
    // Older tests and some harnesses only provide openclawConfigPath; in that
    // case the config directory is the state directory that owns plugin state.
    const openclawStateDir =
      this.env.openclawStateDir ?? path.dirname(this.env.openclawConfigPath);
    await syncWeixinAccountIndex(openclawStateDir, normalized);

    const configStat = await stat(this.env.openclawConfigPath);
    logger.info(
      {
        path: this.env.openclawConfigPath,
        contentLength: content.length,
        inode: configStat.ino,
        size: configStat.size,
        mtimeMs: configStat.mtimeMs,
        finishedAt: Date.now(),
        durationMs: Date.now() - writeStartedAt,
      },
      "openclaw_config_write_complete",
    );
    return { changed: true, revision, config: normalized };
  }
}
