import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ChannelType } from "@nexu/shared";
import { selectPreferredModel } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import {
  type OAuthConnectionState,
  collectAvailableRuntimeModelRefs,
  compileOpenClawConfig,
  resolveModelId,
} from "../lib/openclaw-config-compiler.js";
import type { OpenClawAuthProfilesStore } from "../runtime/openclaw-auth-profiles-store.js";
import type { OpenClawAuthProfilesWriter } from "../runtime/openclaw-auth-profiles-writer.js";
import type { OpenClawConfigWriter } from "../runtime/openclaw-config-writer.js";
import type { OpenClawRuntimeModelWriter } from "../runtime/openclaw-runtime-model-writer.js";
import type { OpenClawRuntimePluginWriter } from "../runtime/openclaw-runtime-plugin-writer.js";
import type { OpenClawWatchTrigger } from "../runtime/openclaw-watch-trigger.js";
import type { WorkspaceTemplateWriter } from "../runtime/workspace-template-writer.js";
import type { CompiledOpenClawStore } from "../store/compiled-openclaw-store.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import type { NexuConfig } from "../store/schemas.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";
import type { SkillDb } from "./skillhub/skill-db.js";
import type { WorkspaceSkillScanner } from "./skillhub/workspace-skill-scanner.js";

function resolvePrimaryModelRef(
  model: string | { primary: string } | undefined,
  config: NexuConfig,
  compiled: ReturnType<typeof compileOpenClawConfig>,
  env: ControllerEnv,
  oauthState: OAuthConnectionState,
): string {
  const availableRuntimeModels = collectAvailableRuntimeModelRefs(
    compiled,
    config,
    oauthState,
  );

  if (typeof model === "string") {
    return resolveAvailableRuntimeModel(
      resolveModelId(config, env, model, oauthState),
      availableRuntimeModels,
    );
  }

  if (model && typeof model.primary === "string") {
    return resolveAvailableRuntimeModel(
      resolveModelId(config, env, model.primary, oauthState),
      availableRuntimeModels,
    );
  }

  return resolveAvailableRuntimeModel(
    resolveModelId(config, env, env.defaultModelId, oauthState),
    availableRuntimeModels,
  );
}

function collectConfiguredChannelTypes(config: NexuConfig): ChannelType[] {
  const seen = new Set<ChannelType>();
  for (const channel of config.channels) {
    seen.add(channel.channelType);
  }
  return [...seen];
}

function resolveAvailableRuntimeModel(
  desiredRef: string,
  availableRuntimeModels: Array<{ id: string; name: string }>,
): string {
  if (availableRuntimeModels.some((model) => model.id === desiredRef)) {
    return desiredRef;
  }

  return selectPreferredModel(availableRuntimeModels)?.id ?? desiredRef;
}

export class OpenClawSyncService {
  private pendingSync: Promise<{ configPushed: boolean }> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private settling = false;
  private settlingDirty = false;
  private settlingResolvers: Array<{
    resolve: (v: { configPushed: boolean }) => void;
    reject: (e: unknown) => void;
  }> = [];
  private static readonly DEBOUNCE_MS = 100;
  private static readonly SETTLING_MIN_MS = 3000;
  private static readonly SETTLING_MAX_MS = 30000;
  private syncCounter = 0;

  constructor(
    private readonly env: ControllerEnv,
    private readonly configStore: NexuConfigStore,
    private readonly compiledStore: CompiledOpenClawStore,
    private readonly configWriter: OpenClawConfigWriter,
    private readonly authProfilesWriter: OpenClawAuthProfilesWriter,
    private readonly authProfilesStore: OpenClawAuthProfilesStore,
    private readonly runtimePluginWriter: OpenClawRuntimePluginWriter,
    private readonly runtimeModelWriter: OpenClawRuntimeModelWriter,
    private readonly templateWriter: WorkspaceTemplateWriter,
    private readonly watchTrigger: OpenClawWatchTrigger,
    private readonly gatewayService: OpenClawGatewayService,
    private readonly skillDb: SkillDb | null = null,
    private readonly workspaceScanner: WorkspaceSkillScanner | null = null,
  ) {}

  async compileCurrentConfig(): Promise<
    ReturnType<typeof compileOpenClawConfig>
  > {
    const config = await this.configStore.getConfig();
    const oauthState = await this.authProfilesStore.getOAuthConnectionState();
    const installedSlugs = this.skillDb
      ? this.skillDb
          .getAllInstalled()
          .filter((r) => r.source !== "workspace")
          .map((r) => r.slug)
      : undefined;

    const workspaceMap = this.workspaceScanner
      ? this.workspaceScanner.scanAll(
          config.bots.filter((b) => b.status === "active").map((b) => b.id),
        )
      : undefined;

    return compileOpenClawConfig(
      config,
      this.env,
      oauthState,
      installedSlugs,
      workspaceMap,
    );
  }

  /**
   * Enter settling mode after bootstrap. All syncAll() calls during
   * this period are deferred. The period ends once the runtime becomes stable,
   * plus a short tail window to absorb follow-up events, or after a max timeout.
   */
  beginSettling(stableSignal?: Promise<void>): Promise<void> {
    this.settling = true;
    this.settlingDirty = false;
    logger.info(
      {},
      `sync settling started (min=${OpenClawSyncService.SETTLING_MIN_MS}ms max=${OpenClawSyncService.SETTLING_MAX_MS}ms)`,
    );
    return new Promise((resolve) => {
      let finished = false;
      let minTimer: ReturnType<typeof setTimeout> | null = null;
      let maxTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (minTimer) {
          clearTimeout(minTimer);
        }
        if (maxTimer) {
          clearTimeout(maxTimer);
        }
        void this.endSettling().finally(resolve);
      };

      const scheduleMinWindow = () => {
        if (finished || minTimer) {
          return;
        }
        minTimer = setTimeout(() => {
          finish();
        }, OpenClawSyncService.SETTLING_MIN_MS);
      };

      maxTimer = setTimeout(() => {
        logger.info(
          {},
          `sync settling timed out (${OpenClawSyncService.SETTLING_MAX_MS}ms)`,
        );
        finish();
      }, OpenClawSyncService.SETTLING_MAX_MS);

      if (stableSignal) {
        void stableSignal.then(
          () => {
            logger.info({}, "sync settling stable signal observed");
            scheduleMinWindow();
          },
          () => {
            scheduleMinWindow();
          },
        );
      } else {
        scheduleMinWindow();
      }
    });
  }

  private async endSettling(): Promise<void> {
    if (!this.settling) {
      return;
    }
    this.settling = false;
    const resolvers = [...this.settlingResolvers];
    this.settlingResolvers = [];

    if (this.settlingDirty) {
      this.settlingDirty = false;
      logger.info({}, "sync settling ended — flushing deferred sync");
      try {
        const result = await this.doSync();
        for (const r of resolvers) r.resolve(result);
      } catch (error) {
        for (const r of resolvers) r.reject(error);
      }
    } else {
      logger.info({}, "sync settling ended — no deferred changes");
      for (const r of resolvers) r.resolve({ configPushed: false });
    }
  }

  /**
   * Debounced sync: coalesces rapid calls within 100ms into a single
   * execution. During settling mode (startup), calls are deferred
   * entirely and flushed once at the end.
   */
  async syncAll(): Promise<{ configPushed: boolean }> {
    if (this.settling) {
      this.settlingDirty = true;
      logger.debug({}, "syncAll deferred (settling mode)");
      return new Promise((resolve, reject) => {
        this.settlingResolvers.push({ resolve, reject });
      });
    }

    // If a sync is already in flight, wait for it and schedule another after
    if (this.pendingSync) {
      await this.pendingSync.catch(() => {});
    }

    return new Promise((resolve, reject) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const p = this.doSync();
        this.pendingSync = p;
        p.then(resolve, reject).finally(() => {
          this.pendingSync = null;
        });
      }, OpenClawSyncService.DEBOUNCE_MS);
    });
  }

  /**
   * Immediate sync bypassing debounce and settling.
   * Used during bootstrap where we need the config written before OpenClaw starts.
   */
  async syncAllImmediate(): Promise<{ configPushed: boolean }> {
    return this.doSync();
  }

  async ensureRuntimeModelPlugin(): Promise<void> {
    const config = await this.configStore.getConfig();
    await this.runtimePluginWriter.ensurePlugins({
      configuredChannelTypes: collectConfiguredChannelTypes(config),
    });
    await this.runtimeModelWriter.writeFallback();
  }

  /**
   * Update only the runtime-model state file (consumed by the
   * `nexu-runtime-model` plugin) without touching openclaw.json.
   *
   * Used by the "switch default model" UI action: the previous behavior
   * wrote a brand-new openclaw.json on every switch, which OpenClaw treats
   * as a config change and tears down + restarts every active channel
   * monitor (Feishu / WeChat / …) — leaving the dashboard stuck in
   * "connecting" for many seconds. The hook reads the runtime-model state
   * file directly, so updating it alone is enough to route subsequent
   * agent runs to the new model.
   */
  async syncRuntimeModelOnly(): Promise<void> {
    const config = await this.configStore.getConfig();
    const oauthState = await this.authProfilesStore.getOAuthConnectionState();
    const installedSlugs = this.skillDb
      ? this.skillDb
          .getAllInstalled()
          .filter((r) => r.source !== "workspace")
          .map((r) => r.slug)
      : undefined;

    const workspaceMap = this.workspaceScanner
      ? this.workspaceScanner.scanAll(
          config.bots.filter((b) => b.status === "active").map((b) => b.id),
        )
      : undefined;

    const compiled = compileOpenClawConfig(
      config,
      this.env,
      oauthState,
      installedSlugs,
      workspaceMap,
    );
    const runtimeModelRef = resolvePrimaryModelRef(
      compiled.agents.defaults?.model,
      config,
      compiled,
      this.env,
      oauthState,
    );
    const availableRuntimeModelRefs = collectAvailableRuntimeModelRefs(
      compiled,
      config,
      oauthState,
    ).map((m) => m.id);
    logger.info(
      {
        runtimeModelRef,
        availableCount: availableRuntimeModelRefs.length,
      },
      "syncRuntimeModelOnly: updating runtime model state",
    );
    await this.runtimeModelWriter.write(
      runtimeModelRef,
      availableRuntimeModelRefs,
    );
  }

  /**
   * Write platform templates to a specific bot's workspace.
   * Called when creating a new bot to seed workspace with platform files.
   */
  async writePlatformTemplatesForBot(botId: string): Promise<void> {
    await this.templateWriter.write([{ id: botId, status: "active" }]);
  }

  private async doSync(): Promise<{ configPushed: boolean }> {
    const seq = ++this.syncCounter;
    const config = await this.configStore.getConfig();
    const oauthState = await this.authProfilesStore.getOAuthConnectionState();
    const installedSlugs = this.skillDb
      ? this.skillDb
          .getAllInstalled()
          .filter((r) => r.source !== "workspace")
          .map((r) => r.slug)
      : undefined;

    const workspaceMap = this.workspaceScanner
      ? this.workspaceScanner.scanAll(
          config.bots.filter((b) => b.status === "active").map((b) => b.id),
        )
      : undefined;

    const compiled = compileOpenClawConfig(
      config,
      this.env,
      oauthState,
      installedSlugs,
      workspaceMap,
    );

    // Re-evaluate which bundled channel plugins should be present in the
    // sidecar extensions directory. add/remove of a channel triggers
    // syncAll(), so this naturally keeps the on-disk plugin set in sync
    // with the user's actual configuration — preventing the sidecar from
    // discovering and repeatedly registering plugins for channels the user
    // never configured.
    await this.runtimePluginWriter.ensurePlugins({
      configuredChannelTypes: collectConfiguredChannelTypes(config),
    });

    logger.info(
      {
        seq,
        modelProviders: Object.keys(compiled.models?.providers ?? {}),
        channels: Object.keys(compiled.channels ?? {}),
        wsConnected: this.gatewayService.isConnected(),
      },
      "doSync: pushing config to OpenClaw",
    );

    // 1. Decide whether this config differs from the last observed snapshot.
    let configPushed = false;
    if (this.gatewayService.isConnected()) {
      try {
        configPushed = await this.gatewayService.shouldPushConfig(compiled);
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "openclaw config diff check failed",
        );
      }
    }

    // 2. Always write files once (persistence + watcher hot-reload path).
    await this.configWriter.write(compiled);
    await this.authProfilesWriter.writeForAgents(compiled, config.providers);
    this.gatewayService.noteConfigWritten(compiled);
    const runtimeModelRef = resolvePrimaryModelRef(
      compiled.agents.defaults?.model,
      config,
      compiled,
      this.env,
      oauthState,
    );
    const availableRuntimeModelRefs = collectAvailableRuntimeModelRefs(
      compiled,
      config,
      oauthState,
    ).map((m) => m.id);
    logger.info(
      {
        seq,
        runtimeModelRef,
        availableCount: availableRuntimeModelRefs.length,
      },
      "doSync: resolved runtime model",
    );
    await this.runtimeModelWriter.write(
      runtimeModelRef,
      availableRuntimeModelRefs,
    );
    await this.compiledStore.saveConfig(compiled);

    // 3. Nudge the file watcher when OpenClaw may not have seen the config:
    //    - WS not connected: file watcher is the only reload path.
    //    - configPushed (hash stale): gateway restarted and may have missed
    //      writes that landed on disk while WS was down. Touch the file so
    //      the watcher triggers a reload even when the content is identical.
    if (!this.gatewayService.isConnected() || configPushed) {
      await this.watchTrigger.touchConfig();
    }

    // 4. Nudge OpenClaw's skills chokidar watcher so it bumps snapshotVersion.
    // Without this, existing sessions keep using a stale skills snapshot
    // even after the allowlist changes, because OpenClaw's config-reload
    // treats agents/skills changes as kind "none" (no hot-reload action).
    if (configPushed) {
      await this.touchAnySkillMarker();
    }

    logger.info({ seq, configPushed }, "doSync: complete");
    return { configPushed };
  }

  /**
   * Touch one SKILL.md to trigger OpenClaw's skills chokidar watcher.
   * Best-effort: silently ignored if no skills exist on disk yet.
   */
  private async touchAnySkillMarker(): Promise<void> {
    try {
      const entries = await import("node:fs/promises").then((fs) =>
        fs.readdir(this.env.openclawSkillsDir, { withFileTypes: true }),
      );
      const first = entries.find(
        (e) =>
          e.isDirectory() &&
          existsSync(resolve(this.env.openclawSkillsDir, e.name, "SKILL.md")),
      );
      if (first) {
        await this.watchTrigger.touchSkill(first.name);
        logger.info(
          { slug: first.name },
          "doSync: touched SKILL.md to bump snapshot version",
        );
      }
    } catch {
      // best-effort
    }
  }
}
