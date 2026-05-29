import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path, { basename } from "node:path";
import type { ChannelType } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { MANAGED_CHANNEL_PLUGIN_IDS } from "../lib/channel-binding-compiler.js";
import { logger } from "../lib/logger.js";

const PLUGIN_COPY_MAX_ATTEMPTS = 6;
const PLUGIN_COPY_RETRY_BASE_DELAY_MS = 100;
const PLUGIN_COPY_RETRY_MAX_DELAY_MS = 1000;
const TRANSIENT_PLUGIN_FS_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

const ALL_BUNDLED_PLUGIN_IDS = new Set([
  "dingtalk-connector",
  "wecom",
  "openclaw-qqbot",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;
}

function isTransientPluginFsError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code !== null && TRANSIENT_PLUGIN_FS_ERROR_CODES.has(code);
}

async function withTransientPluginFsRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PLUGIN_COPY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        !isTransientPluginFsError(error) ||
        attempt === PLUGIN_COPY_MAX_ATTEMPTS
      ) {
        throw error;
      }

      await sleep(
        Math.min(
          PLUGIN_COPY_RETRY_BASE_DELAY_MS * attempt,
          PLUGIN_COPY_RETRY_MAX_DELAY_MS,
        ),
      );
    }
  }

  throw lastError;
}

function shouldCopyPluginPath(sourcePath: string): boolean {
  const name = basename(sourcePath);
  if (name === ".bin" || name === ".cache" || name === ".git") {
    return false;
  }

  const normalizedParts = sourcePath
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase());
  if (
    normalizedParts.some(
      (part) =>
        part === "__tests__" ||
        part === "coverage" ||
        part === "test" ||
        part === "tests",
    )
  ) {
    return false;
  }

  return !/\.(spec|test)\.[cm]?[jt]sx?$/i.test(name);
}

export interface EnsurePluginsOptions {
  /**
   * Channel types the user has actually configured (any status). When provided,
   * bundled plugins for unrelated channels are *not* copied into the sidecar
   * extensions directory. This avoids the sidecar discovering and registering
   * channel plugins (e.g. `openclaw-qqbot`) that the user never configured —
   * which is the dominant source of the every-few-seconds plugin re-register
   * bursts seen in the diagnostic bundle.
   *
   * Pass `undefined` (or omit) to fall back to the legacy "ensure everything"
   * behaviour (bootstrap and tests).
   */
  configuredChannelTypes?: readonly ChannelType[];
}

export class OpenClawRuntimePluginWriter {
  constructor(private readonly env: ControllerEnv) {}

  async ensurePlugins(opts?: EnsurePluginsOptions): Promise<void> {
    await mkdir(this.env.openclawExtensionsDir, { recursive: true });
    await this.cleanupExtensionStagingDirs();
    const requestedBundled = this.resolveRequestedBundled(
      opts?.configuredChannelTypes,
    );
    const handledPluginIds = await this.ensureBundledPlugins(requestedBundled);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.env.runtimePluginTemplatesDir, {
        withFileTypes: true,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || handledPluginIds.has(entry.name)) {
        continue;
      }

      const builtinPluginDir = this.env.openclawBuiltinExtensionsDir
        ? path.join(this.env.openclawBuiltinExtensionsDir, entry.name)
        : null;
      const targetDir = path.join(this.env.openclawExtensionsDir, entry.name);
      if (builtinPluginDir && (await this.exists(builtinPluginDir))) {
        await this.safeRm(targetDir);
        handledPluginIds.add(entry.name);
        continue;
      }

      const sourceDir = path.join(
        this.env.runtimePluginTemplatesDir,
        entry.name,
      );
      await this.safeCopyPlugin(sourceDir, targetDir, entry.name);
    }
  }

  private resolveRequestedBundled(
    configuredChannelTypes: readonly ChannelType[] | undefined,
  ): Set<string> {
    if (!configuredChannelTypes) {
      // Legacy behaviour — ensure every bundled plugin we know about.
      return new Set(ALL_BUNDLED_PLUGIN_IDS);
    }

    const requested = new Set<string>();
    for (const channelType of configuredChannelTypes) {
      const pluginId = MANAGED_CHANNEL_PLUGIN_IDS[channelType];
      if (pluginId && ALL_BUNDLED_PLUGIN_IDS.has(pluginId)) {
        requested.add(pluginId);
      }
    }
    return requested;
  }

  private async ensureBundledPlugins(
    requestedPluginIds: Set<string>,
  ): Promise<Set<string>> {
    const handledPluginIds = new Set<string>();

    // Older `ControllerEnv` shapes (used by some unit tests) don't define
    // `bundledRuntimePluginsDir`. Treat missing/undefined as an empty
    // bundled plugin set rather than letting `readdir(undefined)` throw a
    // TypeError that bubbles all the way out of syncAll.
    if (!this.env.bundledRuntimePluginsDir) {
      return handledPluginIds;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.env.bundledRuntimePluginsDir, {
        withFileTypes: true,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return handledPluginIds;
      }
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !ALL_BUNDLED_PLUGIN_IDS.has(entry.name)) {
        continue;
      }

      const targetDir = path.join(this.env.openclawExtensionsDir, entry.name);
      const builtinPluginDir = this.env.openclawBuiltinExtensionsDir
        ? path.join(this.env.openclawBuiltinExtensionsDir, entry.name)
        : null;

      // The user has not configured a channel that needs this plugin —
      // remove any stale copy from a previous configuration so the sidecar
      // does not discover, load, and repeatedly try to register it.
      if (!requestedPluginIds.has(entry.name)) {
        await this.safeRm(targetDir);
        handledPluginIds.add(entry.name);
        continue;
      }

      if (builtinPluginDir && (await this.exists(builtinPluginDir))) {
        await this.safeRm(targetDir);
        handledPluginIds.add(entry.name);
        continue;
      }

      const sourceDir = path.join(
        this.env.bundledRuntimePluginsDir,
        entry.name,
      );
      await this.safeRm(targetDir);
      await this.safeCopyPlugin(sourceDir, targetDir, entry.name);
      handledPluginIds.add(entry.name);
    }

    return handledPluginIds;
  }

  private async safeCopyPlugin(
    sourceDir: string,
    targetDir: string,
    pluginId: string,
  ): Promise<void> {
    const stagingRoot = path.join(
      this.env.openclawStateDir ?? path.dirname(this.env.openclawExtensionsDir),
      "tmp",
      "plugin-staging",
    );
    const stagingDir = path.join(
      stagingRoot,
      `${pluginId}.staging-${process.pid}-${Date.now()}-${randomUUID()}`,
    );
    try {
      await withTransientPluginFsRetry(async () => {
        await this.rmForCopy(stagingDir);
        await mkdir(path.dirname(targetDir), { recursive: true });
        await mkdir(stagingRoot, { recursive: true });
        await cp(sourceDir, stagingDir, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: true,
          filter: (source) =>
            shouldCopyPluginPath(path.relative(sourceDir, source)),
        });
        await this.rmForCopy(targetDir);
        await rename(stagingDir, targetDir);
      });
    } catch (err) {
      await this.rmForCopy(stagingDir).catch(() => undefined);

      if (await this.hasUsablePlugin(targetDir)) {
        logger.warn(
          { pluginId, targetDir, error: (err as Error).message },
          "plugin_copy_failed_using_existing",
        );
        return;
      }

      logger.error(
        { pluginId, sourceDir, targetDir, error: (err as Error).message },
        "plugin_copy_failed_no_usable_target",
      );
      throw err;
    }
  }

  private async cleanupExtensionStagingDirs(): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.env.openclawExtensionsDir, {
        withFileTypes: true,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes(".staging-")) {
        continue;
      }
      await this.safeRm(path.join(this.env.openclawExtensionsDir, entry.name));
    }
  }

  private async safeRm(targetDir: string): Promise<void> {
    try {
      await rm(targetDir, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        code === "EPERM" ||
        code === "EBUSY" ||
        code === "ENOTEMPTY" ||
        code === "ENOENT"
      ) {
        logger.warn(
          { path: targetDir, error: (err as Error).message },
          "plugin_rm_skipped_fs_lock",
        );
        return;
      }
      throw err;
    }
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async rmForCopy(targetDir: string): Promise<void> {
    try {
      await withTransientPluginFsRetry(() =>
        rm(targetDir, { recursive: true, force: true }),
      );
    } catch (err) {
      if (getErrorCode(err) === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  private async hasUsablePlugin(targetDir: string): Promise<boolean> {
    try {
      await access(path.join(targetDir, "openclaw.plugin.json"));
      await Promise.any([
        access(path.join(targetDir, "index.js")),
        access(path.join(targetDir, "index.ts")),
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
