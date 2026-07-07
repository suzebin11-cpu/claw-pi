import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";

export type OpenClawRuntimeRepairReason =
  | "agent_approval_required"
  | "agent_exec_host_not_allowed"
  | "agent_exec_host_node_unpaired"
  | "agent_model_auth_missing"
  | "gateway_not_ready";

export type OpenClawRuntimeRepairLevel = "soft" | "deep";

export interface OpenClawRuntimeRepairResult {
  ok: boolean;
  reason: OpenClawRuntimeRepairReason;
  level: OpenClawRuntimeRepairLevel;
  skippedCooldown: boolean;
  error?: string;
}

export interface OpenClawRuntimeRepairStatus {
  inProgress: boolean;
  lastReason: OpenClawRuntimeRepairReason | null;
  lastLevel: OpenClawRuntimeRepairLevel | null;
  lastRepairAt: number | null;
  lastError: string | null;
}

type OpenClawRuntimeRepairProcess = {
  isAlive(): boolean;
  stop(): Promise<void>;
  enableAutoRestart(): void;
  start(): void;
};

type OpenClawRuntimeRepairWsClient = {
  isConnected(): boolean;
  connect(): void;
};

type OpenClawRuntimeRepairSyncService = {
  syncAllImmediate(): Promise<{ configPushed: boolean }>;
};

const DEEP_REPAIR_COOLDOWN_MS = 5 * 60_000;
const WS_READY_TIMEOUT_MS = 60_000;
const WS_READY_POLL_MS = 250;

export const LOCAL_RUNTIME_REPAIR_MESSAGE =
  "本地执行环境异常，已自动修复并重试。";
export const LOCAL_RUNTIME_REPAIR_FAILED_MESSAGE =
  "本地执行环境修复失败，请导出诊断包。";

export function classifyOpenClawRuntimeRepairReason(
  message: string,
): OpenClawRuntimeRepairReason | null {
  if (
    /(?:exec host=node requires a paired node|paired node \(none available\)|requires a companion app or node host)/iu.test(
      message,
    )
  ) {
    return "agent_exec_host_node_unpaired";
  }
  if (
    /(?:exec host not allowed|requested auto; configured host is gateway)/iu.test(
      message,
    )
  ) {
    return "agent_exec_host_not_allowed";
  }
  if (
    /(?:\/approve\b|allow-always|需要(?:你)?批准|请(?:点击)?审批|approval required)/iu.test(
      message,
    )
  ) {
    return "agent_approval_required";
  }
  if (
    /(?:No API key found for provider ["']?link["']?|auth-profiles\.json|Configure auth for this agent)/iu.test(
      message,
    )
  ) {
    return "agent_model_auth_missing";
  }
  if (
    /(?:openclaw gateway not connected|gateway not connected|OpenClaw agent chat timed out|request ".*" timed out)/iu.test(
      message,
    )
  ) {
    return "gateway_not_ready";
  }
  return null;
}

function shouldDeepRepair(reason: OpenClawRuntimeRepairReason): boolean {
  return (
    reason === "agent_exec_host_node_unpaired" ||
    reason === "agent_exec_host_not_allowed" ||
    reason === "agent_approval_required"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class OpenClawRuntimeRepairCoordinator {
  private inFlight: Promise<OpenClawRuntimeRepairResult> | null = null;
  private lastDeepRepairAt: number | null = null;
  private status: OpenClawRuntimeRepairStatus = {
    inProgress: false,
    lastReason: null,
    lastLevel: null,
    lastRepairAt: null,
    lastError: null,
  };

  constructor(
    private readonly env: ControllerEnv,
    private readonly syncService: OpenClawRuntimeRepairSyncService,
    private readonly processManager: OpenClawRuntimeRepairProcess,
    private readonly wsClient: OpenClawRuntimeRepairWsClient,
  ) {}

  getStatus(): OpenClawRuntimeRepairStatus {
    return { ...this.status, inProgress: this.inFlight !== null };
  }

  async repairForMessage(
    message: string,
  ): Promise<OpenClawRuntimeRepairResult> {
    const reason = classifyOpenClawRuntimeRepairReason(message);
    if (!reason) {
      return {
        ok: false,
        reason: "gateway_not_ready",
        level: "soft",
        skippedCooldown: false,
        error: "message is not runtime-repairable",
      };
    }
    return this.repair(reason);
  }

  async repair(
    reason: OpenClawRuntimeRepairReason,
  ): Promise<OpenClawRuntimeRepairResult> {
    if (this.inFlight) {
      logger.info({ reason }, "openclaw_repair_join_inflight");
      return this.inFlight;
    }

    const requestedDeepRepair = shouldDeepRepair(reason);
    const cooldownActive =
      requestedDeepRepair &&
      this.lastDeepRepairAt !== null &&
      Date.now() - this.lastDeepRepairAt < DEEP_REPAIR_COOLDOWN_MS;
    const level: OpenClawRuntimeRepairLevel =
      requestedDeepRepair && !cooldownActive ? "deep" : "soft";

    this.inFlight = this.doRepair(reason, level, cooldownActive).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRepair(
    reason: OpenClawRuntimeRepairReason,
    level: OpenClawRuntimeRepairLevel,
    skippedCooldown: boolean,
  ): Promise<OpenClawRuntimeRepairResult> {
    const startedAt = Date.now();
    this.status = {
      inProgress: true,
      lastReason: reason,
      lastLevel: level,
      lastRepairAt: startedAt,
      lastError: null,
    };
    logger.warn({ reason, level, skippedCooldown }, "openclaw_repair_started");

    try {
      if (level === "deep") {
        await this.processManager.stop();
        await this.clearRepairableRuntimeState();
      }

      await this.syncService.syncAllImmediate();

      if (level === "deep") {
        this.lastDeepRepairAt = Date.now();
        this.processManager.enableAutoRestart();
        this.processManager.start();
        this.wsClient.connect();
        await this.waitForWsReady();
      }

      const result: OpenClawRuntimeRepairResult = {
        ok: true,
        reason,
        level,
        skippedCooldown,
      };
      this.status = {
        inProgress: false,
        lastReason: reason,
        lastLevel: level,
        lastRepairAt: Date.now(),
        lastError: null,
      };
      await this.writeSummary(result, Date.now() - startedAt);
      logger.info(
        { reason, level, skippedCooldown, elapsedMs: Date.now() - startedAt },
        "openclaw_repair_finished",
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: OpenClawRuntimeRepairResult = {
        ok: false,
        reason,
        level,
        skippedCooldown,
        error: message,
      };
      this.status = {
        inProgress: false,
        lastReason: reason,
        lastLevel: level,
        lastRepairAt: Date.now(),
        lastError: message,
      };
      await this.writeSummary(result, Date.now() - startedAt).catch(() => {});
      logger.warn(
        {
          reason,
          level,
          skippedCooldown,
          elapsedMs: Date.now() - startedAt,
          error: message,
        },
        "openclaw_repair_failed",
      );
      return result;
    }
  }

  private async waitForWsReady(): Promise<void> {
    const startedAt = Date.now();
    while (!this.wsClient.isConnected()) {
      if (Date.now() - startedAt >= WS_READY_TIMEOUT_MS) {
        throw new Error("OpenClaw gateway did not reconnect after repair");
      }
      await sleep(WS_READY_POLL_MS);
    }
  }

  private async clearRepairableRuntimeState(): Promise<void> {
    const targets = [
      this.env.openclawConfigPath,
      path.join(this.env.openclawStateDir, "tmp"),
      path.join(this.env.openclawStateDir, "cache"),
      path.join(this.env.openclawStateDir, "approval"),
      path.join(this.env.openclawStateDir, "approvals"),
    ];

    for (const target of targets) {
      await rm(target, { recursive: true, force: true });
    }

    const agentsDir = path.join(this.env.openclawStateDir, "agents");
    let agentEntries: Dirent[];
    try {
      agentEntries = await readdir(agentsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of agentEntries) {
      if (!entry.isDirectory()) continue;
      const agentDir = path.join(agentsDir, entry.name);
      for (const name of ["approval", "approvals", "pending-approvals"]) {
        await rm(path.join(agentDir, name), { recursive: true, force: true });
      }
    }
  }

  private async findRecentSessionSnapshot(): Promise<{
    path: string;
    mtimeMs: number;
  } | null> {
    const agentsDir = path.join(this.env.openclawStateDir, "agents");
    let best: { path: string; mtimeMs: number } | null = null;
    let agentEntries: Dirent[];
    try {
      agentEntries = await readdir(agentsDir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const sessionsDir = path.join(agentsDir, agentEntry.name, "sessions");
      let sessionEntries: Dirent[];
      try {
        sessionEntries = await readdir(sessionsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isFile() || !sessionEntry.name.endsWith(".jsonl")) {
          continue;
        }
        const filePath = path.join(sessionsDir, sessionEntry.name);
        try {
          const fileStat = await stat(filePath);
          if (!best || fileStat.mtimeMs > best.mtimeMs) {
            best = { path: filePath, mtimeMs: fileStat.mtimeMs };
          }
        } catch {
          // Ignore unreadable session files.
        }
      }
    }

    return best;
  }

  private async writeSummary(
    result: OpenClawRuntimeRepairResult,
    elapsedMs: number,
  ): Promise<void> {
    const summaryPath = path.join(
      this.env.openclawStateDir,
      "nexu-runtime-repair-summary.json",
    );
    await mkdir(path.dirname(summaryPath), { recursive: true });
    const recentSession = await this.findRecentSessionSnapshot();
    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          cleanupVersion: "0.3.29-runtime-repair",
          preservedCloudLogin: true,
          openclawStateReset: result.level === "deep",
          wechatStateReset: false,
          reason: result.reason,
          level: result.level,
          ok: result.ok,
          skippedCooldown: result.skippedCooldown,
          error: result.error ?? null,
          elapsedMs,
          recentSession,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}
