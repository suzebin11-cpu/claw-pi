import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import {
  normalizeOpenClawConfig,
  openClawConfigRevision,
} from "../lib/openclaw-config-normalization.js";
import type { OpenClawConfigWriter } from "../runtime/openclaw-config-writer.js";
import type { OpenClawWsClient } from "../runtime/openclaw-ws-client.js";
import type { RuntimeHealth } from "../runtime/runtime-health.js";
import type {
  OpenClawConfigReloadPlan,
  OpenClawGatewayService,
} from "./openclaw-gateway-service.js";

export type ConfigSyncCoordinatorState =
  | "RUNNING"
  | "RESTART_PENDING"
  | "DRAINING"
  | "APPLYING_CONFIG"
  | "RESTARTING"
  | "RECONNECTING"
  | "READY";

interface PersistedPendingConfig {
  version: 1;
  configRevision: string;
  createdAt: string;
  changedPaths: string[];
  config: OpenClawConfig;
}

interface AgentChatLeaseState {
  pending: boolean;
  released: boolean;
}

export interface AgentChatLease {
  requestId: string;
  markSubmitted(): Promise<void>;
  release(result: string): Promise<void>;
}

export class GatewayUpdatingError extends Error {
  constructor() {
    super("Gateway 正在安全应用配置更新，请稍后重试");
    this.name = "GatewayUpdatingError";
  }
}

export interface ConfigSyncCoordinatorSnapshot {
  state: ConfigSyncCoordinatorState;
  activeAgentStreams: number;
  pendingAgentRequests: number;
  activeRunIds: string[];
  acceptingNewChats: boolean;
  gatewayConnectionState: "connected" | "disconnected";
  pendingRevision: string | null;
  restartDeferredReason: string | null;
}

const RESTART_OBSERVE_TIMEOUT_MS = 20_000;
const GATEWAY_READY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ConfigSyncCoordinator {
  private state: ConfigSyncCoordinatorState = "RUNNING";
  private activeAgentStreams = 0;
  private pendingAgentRequests = 0;
  private acceptingNewChats = true;
  private activeRunIds = new Set<string>();
  private leases = new Map<string, AgentChatLeaseState>();
  private pendingConfig: PersistedPendingConfig | null = null;
  private restartDeferredReason: string | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private restartTask: Promise<void> | null = null;
  private retrySuppressed = false;
  private readonly pendingPath: string;
  private readonly restartObserveTimeoutMs: number;
  private readonly gatewayReadyTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    env: ControllerEnv,
    private readonly configWriter: OpenClawConfigWriter,
    private readonly gatewayService: OpenClawGatewayService,
    private readonly wsClient: OpenClawWsClient,
    private readonly runtimeHealth: RuntimeHealth,
    options: {
      restartObserveTimeoutMs?: number;
      gatewayReadyTimeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ) {
    this.pendingPath = path.join(
      env.openclawStateDir,
      "claw-pi-config-pending.json",
    );
    this.restartObserveTimeoutMs =
      options.restartObserveTimeoutMs ?? RESTART_OBSERVE_TIMEOUT_MS;
    this.gatewayReadyTimeoutMs =
      options.gatewayReadyTimeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  snapshot(): ConfigSyncCoordinatorSnapshot {
    return {
      state: this.state,
      activeAgentStreams: this.activeAgentStreams,
      pendingAgentRequests: this.pendingAgentRequests,
      activeRunIds: [...this.activeRunIds],
      acceptingNewChats: this.acceptingNewChats,
      gatewayConnectionState: this.wsClient.isConnected()
        ? "connected"
        : "disconnected",
      pendingRevision: this.pendingConfig?.configRevision ?? null,
      restartDeferredReason: this.restartDeferredReason,
    };
  }

  async recoverPendingBeforeGatewayStart(): Promise<boolean> {
    let pending: PersistedPendingConfig;
    try {
      pending = JSON.parse(
        await readFile(this.pendingPath, "utf8"),
      ) as PersistedPendingConfig;
    } catch {
      return false;
    }

    const normalized = normalizeOpenClawConfig(pending.config);
    const revision = openClawConfigRevision(normalized);
    const current = await this.configWriter.read();
    if (current && openClawConfigRevision(current) === revision) {
      await rm(this.pendingPath, { force: true });
      return false;
    }

    const result = await this.configWriter.write(normalized);
    this.gatewayService.noteConfigWritten(result.config);
    await rm(this.pendingPath, { force: true });
    logger.info(
      {
        configRevision: revision,
        recoveryResult: "applied_before_gateway_start",
      },
      "config_sync_startup_recovery",
    );
    return true;
  }

  async beginAgentChat(requestId: string): Promise<AgentChatLease> {
    await this.withLock(() => {
      if (!this.acceptingNewChats) {
        throw new GatewayUpdatingError();
      }
      this.activeAgentStreams += 1;
      this.pendingAgentRequests += 1;
      this.activeRunIds.add(requestId);
      this.leases.set(requestId, { pending: true, released: false });
    });

    return {
      requestId,
      markSubmitted: () => this.markAgentRequestSubmitted(requestId),
      release: (result) => this.releaseAgentChat(requestId, result),
    };
  }

  async submitConfig(
    config: OpenClawConfig,
    options: { bootstrap?: boolean } = {},
  ): Promise<{
    applied: boolean;
    deferred: boolean;
    plan: OpenClawConfigReloadPlan;
  }> {
    const normalized = normalizeOpenClawConfig(config);
    const current = await this.configWriter.read();
    const plan = await this.gatewayService.planConfigChange(
      current,
      normalized,
    );

    if (options.bootstrap) {
      const result = await this.configWriter.write(normalized);
      this.gatewayService.noteConfigWritten(result.config);
      await rm(this.pendingPath, { force: true });
      return { applied: result.changed, deferred: false, plan };
    }

    if (plan.changedPaths.length === 0) {
      logger.debug(
        { configRevision: plan.configRevision, reloadClassification: "noop" },
        "config_sync_noop",
      );
      return { applied: false, deferred: false, plan };
    }

    if (!plan.restartRequired) {
      const result = await this.configWriter.write(normalized);
      this.gatewayService.noteConfigWritten(result.config);
      this.logPlan(plan, result.changed ? "hot" : "noop", null);
      return { applied: result.changed, deferred: false, plan };
    }

    const pending: PersistedPendingConfig = {
      version: 1,
      configRevision: plan.configRevision,
      createdAt: new Date().toISOString(),
      changedPaths: plan.changedPaths,
      config: normalized,
    };
    let shouldRestart = false;
    await this.withLock(async () => {
      // Persist and publish the newest candidate in one serialized operation.
      // This prevents a completed restart from deleting a newer pending file.
      await atomicWriteJson(this.pendingPath, pending);
      this.pendingConfig = pending;
      this.retrySuppressed = false;
      this.state = "RESTART_PENDING";
      this.restartDeferredReason =
        this.activeAgentStreams > 0 || this.pendingAgentRequests > 0
          ? "active_agent_chat"
          : null;
      shouldRestart = this.tryEnterDrainingLocked();
      this.logPlan(plan, "restart_required", this.restartDeferredReason);
    });
    if (shouldRestart) {
      this.startRestartTask();
    }
    return { applied: false, deferred: true, plan };
  }

  private async markAgentRequestSubmitted(requestId: string): Promise<void> {
    await this.withLock(() => {
      const lease = this.leases.get(requestId);
      if (!lease || lease.released || !lease.pending) return;
      lease.pending = false;
      this.pendingAgentRequests = Math.max(0, this.pendingAgentRequests - 1);
    });
  }

  private async releaseAgentChat(
    requestId: string,
    result: string,
  ): Promise<void> {
    let shouldRestart = false;
    await this.withLock(() => {
      const lease = this.leases.get(requestId);
      if (!lease || lease.released) return;
      lease.released = true;
      if (lease.pending) {
        this.pendingAgentRequests = Math.max(0, this.pendingAgentRequests - 1);
      }
      this.activeAgentStreams = Math.max(0, this.activeAgentStreams - 1);
      this.activeRunIds.delete(requestId);
      this.leases.delete(requestId);
      logger.info(
        {
          requestId,
          recoveryResult: result,
          activeAgentStreams: this.activeAgentStreams,
          pendingAgentRequests: this.pendingAgentRequests,
          coordinatorState: this.state,
        },
        "agent_chat_lifecycle_released",
      );
      shouldRestart = this.tryEnterDrainingLocked();
    });
    if (shouldRestart) {
      this.startRestartTask();
    }
  }

  private tryEnterDrainingLocked(): boolean {
    if (
      !this.pendingConfig ||
      this.retrySuppressed ||
      this.restartTask ||
      this.activeAgentStreams !== 0 ||
      this.pendingAgentRequests !== 0
    ) {
      return false;
    }
    // The idle check and admission gate change intentionally happen in this
    // same serialized critical section.
    this.acceptingNewChats = false;
    this.state = "DRAINING";
    this.restartDeferredReason = null;
    return true;
  }

  private startRestartTask(): void {
    if (this.restartTask) return;
    this.restartTask = this.performRestart().finally(() => {
      this.restartTask = null;
      void this.withLock(() => this.tryEnterDrainingLocked()).then(
        (shouldRestart) => {
          if (shouldRestart) this.startRestartTask();
        },
      );
    });
  }

  private async performRestart(): Promise<void> {
    const pending = this.pendingConfig;
    if (!pending) return;
    const previous = await this.configWriter.read();
    const restartStartedAt = new Date().toISOString();
    let sawDisconnect = !this.wsClient.isConnected();
    const unsubscribe = this.wsClient.onDisconnected(() => {
      sawDisconnect = true;
      this.state = "RECONNECTING";
    });

    try {
      this.state = "APPLYING_CONFIG";
      const result = await this.configWriter.write(pending.config);
      this.gatewayService.noteConfigWritten(result.config);
      this.state = "RESTARTING";
      logger.info(
        {
          configRevision: pending.configRevision,
          changedPaths: pending.changedPaths,
          coordinatorState: this.state,
          restartStartedAt,
        },
        "config_sync_restart_started",
      );

      const observeDeadline = Date.now() + this.restartObserveTimeoutMs;
      while (!sawDisconnect && Date.now() < observeDeadline) {
        await delay(this.pollIntervalMs);
      }
      if (!sawDisconnect) {
        throw new Error("Gateway did not begin the planned restart");
      }

      this.state = "RECONNECTING";
      const readyDeadline = Date.now() + this.gatewayReadyTimeoutMs;
      while (Date.now() < readyDeadline) {
        if (this.wsClient.isConnected()) {
          const health = await this.runtimeHealth
            .probe()
            .catch(() => ({ ok: false }));
          if (health.ok) {
            const gatewayReadyAt = new Date().toISOString();
            await this.withLock(async () => {
              if (
                this.pendingConfig?.configRevision === pending.configRevision
              ) {
                await rm(this.pendingPath, { force: true });
                this.pendingConfig = null;
                this.state = "READY";
                this.acceptingNewChats = true;
                this.restartDeferredReason = null;
                return true;
              }
              this.state = "RESTART_PENDING";
              this.acceptingNewChats = false;
              this.restartDeferredReason = null;
              return false;
            });
            logger.info(
              {
                configRevision: pending.configRevision,
                coordinatorState: this.state,
                restartStartedAt,
                gatewayReadyAt,
                recoveryResult: "ready",
              },
              "config_sync_restart_complete",
            );
            return;
          }
        }
        await delay(this.pollIntervalMs);
      }
      throw new Error("Gateway did not become ready after config restart");
    } catch (error) {
      if (previous) {
        const rollback = await this.configWriter
          .write(previous)
          .catch(() => null);
        if (rollback) this.gatewayService.noteConfigWritten(rollback.config);
      }
      await this.withLock(() => {
        this.state = "RESTART_PENDING";
        this.acceptingNewChats = true;
        this.restartDeferredReason = "restart_failed_pending_retained";
        this.retrySuppressed = true;
      });
      logger.error(
        {
          configRevision: pending.configRevision,
          coordinatorState: this.state,
          restartStartedAt,
          recoveryResult: "rollback",
          error: error instanceof Error ? error.message : String(error),
        },
        "config_sync_restart_failed",
      );
    } finally {
      unsubscribe();
    }
  }

  private logPlan(
    plan: OpenClawConfigReloadPlan,
    reloadClassification: string,
    restartDeferredReason: string | null,
  ): void {
    logger.info(
      {
        configRevision: plan.configRevision,
        changedPaths: plan.changedPaths,
        hotReloadPaths: plan.hotReloadPaths,
        restartRequiredPaths: plan.restartRequiredPaths,
        reloadClassification,
        activeAgentStreams: this.activeAgentStreams,
        pendingAgentRequests: this.pendingAgentRequests,
        coordinatorState: this.state,
        restartDeferredReason,
      },
      "config_sync_planned",
    );
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.serial.then(operation, operation);
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
