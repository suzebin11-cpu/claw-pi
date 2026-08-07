/**
 * OpenClaw Gateway Service
 *
 * High-level business API for communicating with the OpenClaw Gateway via
 * WebSocket RPC. Wraps the low-level OpenClawWsClient to provide:
 *
 * - Config push (direct file write for hot-reload without restart)
 * - Channel status query (channels.status)
 * - Single-channel readiness check
 */

import { createHash } from "node:crypto";
import type { OpenClawConfig } from "@nexu/shared";
import { logger } from "../lib/logger.js";
import {
  diffOpenClawConfigPaths,
  normalizeOpenClawConfig,
  openClawConfigRevision,
} from "../lib/openclaw-config-normalization.js";
import type {
  OpenClawProcessLike,
  OpenClawWsClient,
} from "../runtime/openclaw-ws-client.js";
import type { ControllerRuntimeState } from "../runtime/state.js";

// ---------------------------------------------------------------------------
// Public types — channel status & readiness
// ---------------------------------------------------------------------------

/** Snapshot of a single channel account as returned by channels.status RPC. */
export interface ChannelAccountSnapshot {
  accountId: string;
  connected?: boolean;
  running?: boolean;
  configured?: boolean;
  enabled?: boolean;
  restartPending?: boolean;
  lastError?: string | null;
  probe?: { ok?: boolean };
  linked?: boolean;
}

export interface ChannelSelfPresence {
  e164?: string | null;
  jid?: string | null;
}

export interface ChannelSummarySnapshot {
  configured?: boolean;
  linked?: boolean;
  self?: ChannelSelfPresence | null;
}

/** Result of channels.status RPC. */
export interface ChannelsStatusResult {
  channelOrder: string[];
  channels?: Record<string, ChannelSummarySnapshot>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
}

/** Readiness info for a single channel, used by the readiness endpoint. */
export interface ChannelReadiness {
  ready: boolean;
  connected: boolean;
  running: boolean;
  configured: boolean;
  lastError: string | null;
  gatewayConnected: boolean;
}

export type ChannelLiveStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"
  | "restarting";

export interface ChannelLiveStatusEntry {
  channelType: string;
  channelId: string;
  accountId: string;
  status: ChannelLiveStatus;
  ready: boolean;
  connected: boolean;
  running: boolean;
  configured: boolean;
  lastError: string | null;
  /**
   * When true, this entry is served from a sticky snapshot taken while the
   * gateway was healthy, because a fresh status is currently unavailable
   * (WS transiently disconnected, or channels.status RPC timed out while the
   * OpenClaw event loop is stalled). The front-end uses this flag to render
   * a "syncing…" hint without downgrading the status pill.
   */
  stale?: boolean;
}

export interface SendChannelMessageInput {
  channel: string;
  to: string;
  message: string;
  accountId?: string;
  threadId?: string;
  sessionKey?: string;
  idempotencyKey?: string;
}

export interface SendChannelMessageResult {
  runId?: string;
  messageId?: string;
  channel?: string;
  chatId?: string;
  conversationId?: string;
}

export interface LogoutChannelAccountResult {
  cleared?: boolean;
  loggedOut?: boolean;
}

export interface OpenClawConfigReloadPlan {
  changedPaths: string[];
  hotReloadPaths: string[];
  restartRequiredPaths: string[];
  noopPaths: string[];
  restartRequired: boolean;
  configRevision: string;
}

interface LiveStatusChannelInput {
  id: string;
  channelType: string;
  accountId: string;
}

function isImplicitlyReadyChannelType(channelType: string): boolean {
  return channelType === "feishu";
}

function isConfiguredAsConnectedChannelType(channelType: string): boolean {
  return channelType === "dingtalk";
}

function resolveOpenClawChannelType(channelType: string): string {
  if (channelType === "wechat") {
    return "openclaw-weixin";
  }
  if (channelType === "dingtalk") {
    return "dingtalk-connector";
  }
  return channelType;
}

function resolveOpenClawAccountId(
  channelType: string,
  accountId: string,
): string {
  if (channelType === "qqbot") {
    return "default";
  }
  if (channelType === "dingtalk" && accountId === "default") {
    return "__default__";
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * How long a successful channels.status snapshot stays usable as a transient
 * fallback if the next probe times out. Long enough to absorb a normal agent
 * turn or a Windows AV-induced stall, short enough that real outages still
 * surface within a few polling cycles. Used by `getChannelsStatusSnapshot`
 * for whole-result RPC-layer grace caching.
 */
const LIVE_STATUS_GRACE_MS = 30_000;

/**
 * Per-channel sticky window for `getAllChannelsLiveStatus`. Longer than the
 * RPC-layer grace so the UI keeps showing the last known per-channel status
 * (with a `stale` hint) through a WeChat first-message cold start (~60-120s
 * event-loop blockage on Windows), instead of flipping every pill back to
 * "connecting" the moment WS hiccups.
 */
const STICKY_SNAPSHOT_WINDOW_MS = 120_000;

function makeChannelKey(channelType: string, channelId: string): string {
  return `${channelType}:${channelId}`;
}

export class OpenClawGatewayService {
  /** SHA-256 hash of the last config we successfully observed. */
  private lastPushedConfigHash: string | null = null;
  private wroteWhileDisconnected = false;
  private trackDisconnectedWrites = false;
  private readonly processManager: OpenClawProcessLike | null;

  /**
   * Last successful channels.status snapshot, used as a short grace cache so
   * that a single RPC timeout (e.g. OpenClaw event-loop briefly blocked while
   * loading skills or executing an agent turn) does not flip the UI to
   * "数据同步中" / disconnected when the gateway is in fact still up.
   */
  private lastChannelsStatusSnapshot: {
    result: ChannelsStatusResult;
    capturedAtMs: number;
  } | null = null;

  /**
   * Last successful {@link getAllChannelsLiveStatus} result, keyed by
   * channelType:channelId. Used to keep the UI stable while the gateway is
   * transiently unreachable instead of flipping every pill to "connecting".
   */
  private lastLiveStatusSnapshot: {
    at: number;
    byKey: Map<string, ChannelLiveStatusEntry>;
  } | null = null;

  constructor(
    private readonly wsClient: OpenClawWsClient,
    private readonly runtimeState: ControllerRuntimeState,
    opts?: { processManager?: OpenClawProcessLike },
  ) {
    this.processManager = opts?.processManager ?? null;
  }

  /** Whether the WS client has completed handshake and is ready for RPC. */
  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  /**
   * Pre-seed the config hash so the next pushConfig() call skips if
   * the config hasn't changed. Used during bootstrap to avoid a
   * redundant config.apply → SIGUSR1 cycle on first WS connect.
   */
  preSeedConfigHash(config: OpenClawConfig): void {
    this.lastPushedConfigHash = this.configHash(config);
  }

  async shouldPushConfig(config: OpenClawConfig): Promise<boolean> {
    const hash = this.configHash(config);

    if (hash === this.lastPushedConfigHash) {
      logger.info({}, "openclaw_push_skipped_unchanged");
      return false;
    }
    return true;
  }

  noteConfigWritten(config: OpenClawConfig): void {
    this.lastPushedConfigHash = this.configHash(config);
    if (this.trackDisconnectedWrites && !this.wsClient.isConnected()) {
      this.wroteWhileDisconnected = true;
    }
  }

  async planConfigChange(
    previous: OpenClawConfig | null,
    next: OpenClawConfig,
  ): Promise<OpenClawConfigReloadPlan> {
    const normalizedNext = normalizeOpenClawConfig(next);
    const revision = openClawConfigRevision(normalizedNext);
    const changedPaths = previous
      ? diffOpenClawConfigPaths(
          normalizeOpenClawConfig(previous),
          normalizedNext,
        )
      : ["<root>"];
    if (changedPaths.length === 0) {
      return {
        changedPaths,
        hotReloadPaths: [],
        restartRequiredPaths: [],
        noopPaths: [],
        restartRequired: false,
        configRevision: revision,
      };
    }

    if (this.wsClient.isConnected()) {
      try {
        const remotePlan = await this.wsClient.request<
          Partial<OpenClawConfigReloadPlan>
        >(
          "nexu.config.plan",
          { changedPaths, configRevision: revision },
          { timeoutMs: 5000 },
        );
        const hotReloadPaths = Array.isArray(remotePlan.hotReloadPaths)
          ? remotePlan.hotReloadPaths.filter(
              (value) => typeof value === "string",
            )
          : [];
        const reportedRestartPaths = Array.isArray(
          remotePlan.restartRequiredPaths,
        )
          ? remotePlan.restartRequiredPaths.filter(
              (value) => typeof value === "string",
            )
          : [];
        const noopPaths = Array.isArray(remotePlan.noopPaths)
          ? remotePlan.noopPaths.filter((value) => typeof value === "string")
          : [];
        const classifiedPaths = new Set([
          ...hotReloadPaths,
          ...reportedRestartPaths,
          ...noopPaths,
        ]);
        const restartRequiredPaths = [
          ...reportedRestartPaths,
          ...changedPaths.filter((path) => !classifiedPaths.has(path)),
        ];
        return {
          changedPaths,
          hotReloadPaths,
          restartRequiredPaths,
          noopPaths,
          restartRequired: restartRequiredPaths.length > 0,
          configRevision: revision,
        };
      } catch (error) {
        logger.warn(
          {
            configRevision: revision,
            changedPaths,
            error: error instanceof Error ? error.message : String(error),
          },
          "openclaw_config_plan_rpc_failed",
        );
      }
    }

    // An unavailable/older planning endpoint must fail safe. Deferring an
    // unnecessary restart is preferable to interrupting an active chat.
    return {
      changedPaths,
      hotReloadPaths: [],
      restartRequiredPaths: changedPaths,
      noopPaths: [],
      restartRequired: true,
      configRevision: revision,
    };
  }

  /**
   * Start tracking writes that happen while the gateway is disconnected.
   * Bootstrap writes before the first WS handshake are already read from disk
   * during process start, so they should not trigger reconnect compensation.
   */
  enableDisconnectedWriteTracking(): void {
    this.trackDisconnectedWrites = true;
    this.wroteWhileDisconnected = false;
  }

  invalidateIfDirty(): boolean {
    if (!this.wroteWhileDisconnected) {
      return false;
    }

    this.wroteWhileDisconnected = false;
    this.lastPushedConfigHash = null;
    return true;
  }

  /**
   * Clear the cached config hash so the next shouldPushConfig() returns true.
   * Must be called when the gateway restarts (WS reconnect) because the
   * restarted gateway may not have loaded the latest config from disk —
   * writes that landed while WS was down are invisible to the gateway.
   */
  invalidateConfigHash(): void {
    this.lastPushedConfigHash = null;
  }

  /**
   * Query the runtime status snapshot of all channels.
   * When probe=true, real-time probes are triggered (e.g. Feishu bot-info validation).
   *
   * A single transient RPC failure is absorbed by the snapshot grace cache
   * inside `getChannelsStatusSnapshot` (see `LIVE_STATUS_GRACE_MS`), so
   * downstream callers (`getChannelReadiness`, dashboard, etc.) no longer
   * flicker to "disconnected" when the sidecar event loop is briefly busy.
   */
  async getChannelsStatus(): Promise<ChannelsStatusResult> {
    return this.getChannelsStatusSnapshot({ probe: true, timeoutMs: 12000 });
  }

  async sendChannelMessage(
    input: SendChannelMessageInput,
  ): Promise<SendChannelMessageResult> {
    return this.wsClient.request<SendChannelMessageResult>("send", {
      to: input.to,
      message: input.message,
      channel: input.channel,
      accountId: input.accountId,
      threadId: input.threadId,
      sessionKey: input.sessionKey,
      idempotencyKey:
        input.idempotencyKey ??
        createHash("sha256")
          .update(
            JSON.stringify({
              channel: input.channel,
              to: input.to,
              message: input.message,
              accountId: input.accountId ?? null,
              threadId: input.threadId ?? null,
              sessionKey: input.sessionKey ?? null,
            }),
          )
          .digest("hex"),
    });
  }

  async logoutChannelAccount(
    channelType: string,
    accountId?: string,
  ): Promise<LogoutChannelAccountResult> {
    const channel = resolveOpenClawChannelType(channelType.trim());
    return this.wsClient.request<LogoutChannelAccountResult>(
      "channels.logout",
      {
        channel,
        ...(accountId ? { accountId } : {}),
      },
      { timeoutMs: 5000 },
    );
  }

  async getChannelsStatusSnapshot(opts?: {
    probe?: boolean;
    timeoutMs?: number;
  }): Promise<ChannelsStatusResult> {
    // Note: timeoutMs is the *RPC* deadline and must be passed via the third
    // wsClient.request argument; passing it inside the params object is a
    // no-op and the call would silently fall back to the global 15s deadline.
    try {
      const result = await this.wsClient.request<ChannelsStatusResult>(
        "channels.status",
        { probe: opts?.probe ?? true },
        { timeoutMs: opts?.timeoutMs ?? 12000 },
      );
      this.lastChannelsStatusSnapshot = {
        result,
        capturedAtMs: Date.now(),
      };
      return result;
    } catch (err) {
      const cached = this.lastChannelsStatusSnapshot;
      const ageMs = cached
        ? Date.now() - cached.capturedAtMs
        : Number.POSITIVE_INFINITY;
      if (cached && ageMs <= LIVE_STATUS_GRACE_MS) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            cacheAgeMs: ageMs,
            probe: opts?.probe ?? true,
          },
          "openclaw_channels_status_using_cached_snapshot",
        );
        return cached.result;
      }
      throw err;
    }
  }

  async getAllChannelsLiveStatus(channels: LiveStatusChannelInput[]): Promise<{
    gatewayConnected: boolean;
    channels: ChannelLiveStatusEntry[];
  }> {
    if (!this.wsClient.isConnected()) {
      const sticky = this.buildStickyFallback(channels, "ws_disconnected");
      if (sticky) {
        return sticky;
      }

      // Show "connecting" whenever the WS disconnect is transient:
      //  - booting: initial startup, WS hasn't connected yet
      //  - gateway starting: health loop detected gateway not reachable, process alive
      //  - gateway active: last health check passed but WS ticked out (event-loop blocked)
      // Only show "disconnected" for degraded/unhealthy (real problems).
      const startupStatus: ChannelLiveStatus =
        this.runtimeState.bootPhase === "booting" ||
        this.runtimeState.gatewayStatus === "starting" ||
        this.runtimeState.gatewayStatus === "active"
          ? "connecting"
          : "disconnected";
      return {
        gatewayConnected: false,
        channels: channels.map((channel) => ({
          channelType: channel.channelType,
          channelId: channel.id,
          accountId: channel.accountId,
          status: startupStatus,
          ready: false,
          connected: false,
          running: false,
          configured: false,
          lastError: null,
        })),
      };
    }

    let status: ChannelsStatusResult;
    try {
      // Bumped from 1s to 5s. The previous deadline was tighter than common
      // event-loop blocking windows on Windows (skill load, agent turn) and
      // tripped a transient `gatewayConnected:false` every time the runtime
      // was busy, which the dashboard surfaced as "数据同步中" / disconnected
      // even though the gateway was healthy. A single RPC failure within
      // LIVE_STATUS_GRACE_MS is absorbed inside getChannelsStatusSnapshot
      // (returns last known-good snapshot); only persistent failure throws.
      status = await this.getChannelsStatusSnapshot({
        probe: false,
        timeoutMs: 5000,
      });

      const entries: ChannelLiveStatusEntry[] = channels.map((channel) => {
        const openclawChannelId = resolveOpenClawChannelType(
          channel.channelType,
        );
        const openclawAccountId = resolveOpenClawAccountId(
          channel.channelType,
          channel.accountId,
        );
        const accounts = status.channelAccounts?.[openclawChannelId] ?? [];
        const snapshot = accounts.find(
          (entry) => entry.accountId === openclawAccountId,
        );

        if (!snapshot) {
          if (isImplicitlyReadyChannelType(channel.channelType)) {
            return {
              channelType: channel.channelType,
              channelId: channel.id,
              accountId: channel.accountId,
              status: "connected" satisfies ChannelLiveStatus,
              ready: true,
              connected: false,
              running: true,
              configured: true,
              lastError: null,
            };
          }

          return {
            channelType: channel.channelType,
            channelId: channel.id,
            accountId: channel.accountId,
            status: "restarting" satisfies ChannelLiveStatus,
            ready: false,
            connected: false,
            running: false,
            configured: false,
            lastError: null,
          };
        }

        const connected = snapshot.connected === true;
        const running = snapshot.running === true;
        const configured = snapshot.configured === true;
        const enabled = snapshot.enabled !== false;
        const hasProbeOk = snapshot.probe?.ok === true;
        const rawLastError = snapshot.lastError?.trim()
          ? snapshot.lastError
          : null;
        const lastError = rawLastError === "disabled" ? null : rawLastError;

        // WeChat "not configured" typically means session expired — the
        // plugin paused after errcode -14 and gateway sees the channel as
        // unconfigured. Surface a friendlier error.
        const friendlyError =
          openclawChannelId === "openclaw-weixin" &&
          lastError === "not configured" &&
          !running
            ? "session expired"
            : lastError;

        // For channels like Feishu where `connected` is always false
        // (they use long-polling/WS to Feishu servers, not a direct
        // inbound connection), running + configured + no error means
        // the channel is operational.
        const operationalWithoutProbe =
          (running && configured && !lastError) ||
          (isConfiguredAsConnectedChannelType(channel.channelType) &&
            configured &&
            !lastError);
        const effectiveRunning =
          enabled && (running || operationalWithoutProbe);
        const ready =
          enabled &&
          (connected ||
            (running && configured && hasProbeOk) ||
            operationalWithoutProbe);

        let derivedStatus: ChannelLiveStatus;
        if (!enabled) {
          derivedStatus = "disconnected";
        } else if (lastError) {
          derivedStatus = "error";
        } else if (snapshot.restartPending === true) {
          derivedStatus = "restarting";
        } else if (ready || operationalWithoutProbe) {
          derivedStatus = "connected";
        } else if (running || (configured && enabled)) {
          derivedStatus = "connecting";
        } else {
          derivedStatus = "disconnected";
        }

        return {
          channelType: channel.channelType,
          channelId: channel.id,
          accountId: channel.accountId,
          status: derivedStatus,
          ready,
          connected: enabled && connected,
          running: effectiveRunning,
          configured,
          lastError: friendlyError,
        };
      });

      this.recordLiveStatusSnapshot(entries);

      return {
        gatewayConnected: true,
        channels: entries,
      };
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
        },
        "openclaw_channels_live_status_error",
      );

      const sticky = this.buildStickyFallback(channels, "rpc_timeout");
      if (sticky) {
        return sticky;
      }

      // channels.status RPC timed out even though WS reports connected. This
      // usually means the gateway event loop is blocked (e.g. WeChat cold
      // start sync-buf load on Windows). Show "connecting" instead of
      // alarming users with a false "disconnected" during a transient stall.
      const rpcFailbackStatus: ChannelLiveStatus =
        this.runtimeState.bootPhase === "booting" ||
        this.runtimeState.gatewayStatus === "starting" ||
        this.runtimeState.gatewayStatus === "active"
          ? "connecting"
          : "disconnected";
      return {
        gatewayConnected: false,
        channels: channels.map((channel) => ({
          channelType: channel.channelType,
          channelId: channel.id,
          accountId: channel.accountId,
          status: rpcFailbackStatus,
          ready: false,
          connected: false,
          running: false,
          configured: false,
          lastError: null,
        })),
      };
    }
  }

  /**
   * Remember the latest successful live-status result so that subsequent
   * transient gateway failures can be papered over instead of flipping the UI
   * to "connecting" for every affected channel.
   */
  private recordLiveStatusSnapshot(entries: ChannelLiveStatusEntry[]): void {
    const byKey = new Map<string, ChannelLiveStatusEntry>();
    for (const entry of entries) {
      byKey.set(makeChannelKey(entry.channelType, entry.channelId), entry);
    }
    this.lastLiveStatusSnapshot = { at: Date.now(), byKey };
  }

  /**
   * Try to reuse the last good snapshot while the gateway is momentarily
   * unreachable. Returns null when sticky fallback is not eligible, leaving
   * callers to fall back to their "connecting" / "disconnected" defaults.
   *
   * Gating conditions (all must hold for the snapshot to be reused):
   *  - We have a recent snapshot (< STICKY_SNAPSHOT_WINDOW_MS old).
   *  - Process manager (if wired) still reports isAlive() === true.
   *  - gatewayStatus is not observed as unhealthy/degraded, which indicates
   *    the gateway is probably really broken rather than just slow.
   *  - We have cached entries for every channel the caller asked about
   *    (missing channels mean new configuration that sticky cannot serve).
   */
  private buildStickyFallback(
    channels: LiveStatusChannelInput[],
    reason: "ws_disconnected" | "rpc_timeout",
  ): { gatewayConnected: boolean; channels: ChannelLiveStatusEntry[] } | null {
    const snapshot = this.lastLiveStatusSnapshot;
    if (!snapshot) {
      return null;
    }

    const age = Date.now() - snapshot.at;
    if (age > STICKY_SNAPSHOT_WINDOW_MS) {
      return null;
    }

    const gatewayStatus = this.runtimeState.gatewayStatus;
    if (gatewayStatus === "unhealthy" || gatewayStatus === "degraded") {
      return null;
    }

    if (this.processManager && !this.processManager.isAlive()) {
      return null;
    }

    const stickyChannels: ChannelLiveStatusEntry[] = [];
    for (const input of channels) {
      const cached = snapshot.byKey.get(
        makeChannelKey(input.channelType, input.id),
      );
      if (!cached) {
        return null;
      }
      const shouldSoftenConnected =
        input.channelType === "wechat" && cached.status === "connected";
      stickyChannels.push({
        ...cached,
        accountId: input.accountId,
        status: shouldSoftenConnected ? "connecting" : cached.status,
        ready: shouldSoftenConnected ? false : cached.ready,
        connected: shouldSoftenConnected ? false : cached.connected,
        stale: true,
      });
    }

    logger.info(
      {
        reason,
        ageMs: age,
        gatewayStatus,
        channels: stickyChannels.length,
      },
      "openclaw_channels_live_status_sticky",
    );

    return {
      // Honest: the gateway truly isn't reachable right now. The UI uses the
      // per-channel `stale` flag to decide whether to show "syncing…" next to
      // an otherwise-green pill.
      gatewayConnected: false,
      channels: stickyChannels,
    };
  }

  /**
   * Query the readiness state of a single channel.
   *
   * Readiness logic:
   * - WebSocket-based channels (Slack/Discord): connected === true
   * - Webhook-based channels (Feishu): running && configured && probe.ok
   *
   * Returns gatewayConnected: false when WS is not connected (graceful degradation).
   */
  async getChannelReadiness(
    channelType: string,
    accountId: string,
  ): Promise<ChannelReadiness> {
    if (!this.wsClient.isConnected()) {
      return {
        ready: false,
        connected: false,
        running: false,
        configured: false,
        lastError: null,
        gatewayConnected: false,
      };
    }

    try {
      const status = await this.getChannelsStatus();
      const openclawId = resolveOpenClawChannelType(channelType);
      const openclawAccountId = resolveOpenClawAccountId(
        channelType,
        accountId,
      );
      const accounts = status.channelAccounts?.[openclawId] ?? [];
      const snapshot = accounts.find((a) => a.accountId === openclawAccountId);

      if (!snapshot) {
        if (isImplicitlyReadyChannelType(channelType)) {
          return {
            ready: true,
            connected: false,
            running: true,
            configured: true,
            lastError: null,
            gatewayConnected: true,
          };
        }

        // Channel not yet visible to OpenClaw (config not yet loaded)
        return {
          ready: false,
          connected: false,
          running: false,
          configured: false,
          lastError: null,
          gatewayConnected: true,
        };
      }

      // WebSocket-based channels (Slack, Discord): connected === true.
      // Channels like Feishu can keep `connected=false` while still being
      // operational; mirror getAllChannelsLiveStatus so per-channel readiness
      // does not contradict the global status pill.
      const isEnabled = snapshot.enabled !== false;
      if (!isEnabled) {
        return {
          ready: false,
          connected: false,
          running: false,
          configured: snapshot.configured ?? false,
          lastError: null,
          gatewayConnected: true,
        };
      }

      const isConnected = snapshot.connected === true;
      const rawLastError = snapshot.lastError?.trim()
        ? snapshot.lastError
        : null;
      const friendlyError =
        openclawId === "openclaw-weixin" &&
        rawLastError === "not configured" &&
        snapshot.running !== true
          ? "session expired"
          : rawLastError;
      const isWebhookReady =
        snapshot.running === true &&
        snapshot.configured === true &&
        snapshot.probe?.ok === true;
      const isOperationalWithoutProbe =
        snapshot.running === true &&
        snapshot.configured === true &&
        !friendlyError;
      const isConfiguredReady =
        isConfiguredAsConnectedChannelType(channelType) &&
        snapshot.configured === true &&
        !friendlyError;
      const ready =
        isConnected ||
        isWebhookReady ||
        isOperationalWithoutProbe ||
        isConfiguredReady;

      return {
        ready,
        connected: snapshot.connected ?? false,
        running: snapshot.running ?? isConfiguredReady,
        configured: snapshot.configured ?? false,
        lastError: friendlyError,
        gatewayConnected: true,
      };
    } catch (err) {
      logger.warn(
        {
          channelType,
          accountId,
          error: err instanceof Error ? err.message : String(err),
        },
        "openclaw_channel_readiness_error",
      );
      return {
        ready: false,
        connected: false,
        running: false,
        configured: false,
        lastError: null,
        gatewayConnected: false,
      };
    }
  }

  async wechatQrStart(): Promise<{
    qrDataUrl?: string;
    message: string;
    sessionKey?: string;
  }> {
    // Retry once if the WS hasn't reconnected yet (e.g. after config push restart).
    if (!this.wsClient.isConnected()) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    return this.wsClient.request("web.login.start", {});
  }

  async wechatQrWait(sessionKey: string): Promise<{
    connected: boolean;
    message: string;
    accountId?: string;
  }> {
    return this.wsClient.request(
      "web.login.wait",
      { accountId: sessionKey },
      { timeoutMs: 500_000 },
    );
  }

  async whatsappQrStart(accountId: string): Promise<{
    qrDataUrl?: string;
    message: string;
    accountId?: string;
  }> {
    if (!this.wsClient.isConnected()) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    return this.wsClient.request(
      "web.login.start",
      {
        accountId,
        force: true,
      },
      { timeoutMs: 60_000 },
    );
  }

  async whatsappQrWait(accountId: string): Promise<{
    connected: boolean;
    message: string;
  }> {
    return this.wsClient.request(
      "web.login.wait",
      { accountId },
      { timeoutMs: 500_000 },
    );
  }

  private configHash(config: OpenClawConfig): string {
    return openClawConfigRevision(config);
  }
}
