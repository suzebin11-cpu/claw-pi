import { useEffect, useRef, useState } from "react";

export type RuntimeStatus = "active" | "starting" | "degraded" | "unhealthy";

export type RuntimeReadySnapshot = {
  status?: RuntimeStatus;
  gatewayConnected?: boolean;
  bootTimestamp?: number;
  model?: {
    ready?: boolean;
    defaultModelId?: string | null;
    effectiveModelId?: string | null;
  };
};

export type ChannelLiveStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"
  | "restarting";

/**
 * Maximum wall-clock time from boot during which grace is active.
 * Safety cap — grace normally ends earlier via STABLE_ONLINE_THRESHOLD_MS.
 */
export const BOOT_GRACE_MS = 300_000;

/**
 * How long the runtime must be continuously fully-online before boot grace
 * ends.  Covers the OpenClaw gateway post-connect stabilization window where
 * plugin initialization can temporarily block the event loop.
 */
export const STABLE_ONLINE_THRESHOLD_MS = 90_000;

/**
 * Delay before a channel status downgrade (connected → disconnected) is
 * reflected in the UI.  Prevents brief flickers from appearing as outages.
 */
export const CHANNEL_STATUS_HYSTERESIS_MS = 15_000;

export function isRuntimeFullyOnline(
  runtime: RuntimeReadySnapshot | undefined,
): boolean {
  return (
    runtime?.status === "active" &&
    runtime.gatewayConnected === true &&
    runtime.model?.ready === true
  );
}

/**
 * @deprecated Kept for test compatibility. Prefer `useBootGrace` hook.
 */
export function shouldShowBootGrace(params: {
  bootTimestamp?: number;
  acknowledgedBootTimestamp?: number | null;
  now?: number;
}): boolean {
  const {
    bootTimestamp,
    acknowledgedBootTimestamp = null,
    now = Date.now(),
  } = params;
  if (typeof bootTimestamp !== "number") {
    return false;
  }
  if (acknowledgedBootTimestamp === bootTimestamp) {
    return false;
  }
  return now - bootTimestamp < BOOT_GRACE_MS;
}

export function resolveBootGraceChannelStatus(
  status: ChannelLiveStatus | undefined,
  showBootGrace: boolean,
): ChannelLiveStatus | undefined {
  if (showBootGrace && (status === "disconnected" || status === undefined)) {
    return "connecting";
  }
  return status;
}

export function shouldDelayChannelStatusTransition(
  previousDisplayStatus: ChannelLiveStatus | undefined,
  rawStatus: ChannelLiveStatus | undefined,
  lastError: string | null,
): boolean {
  if (lastError) {
    return false;
  }
  if (previousDisplayStatus !== "connected") {
    return false;
  }
  // Any downgrade away from "connected" without a real error is treated as
  // potentially transient (gateway WS tick timeout, RPC stall during WeChat
  // sync-buf, brief in-process restart).  Defer the UI downgrade so users
  // don't see "Disconnected" flicker for a few seconds.
  return (
    rawStatus === "disconnected" ||
    rawStatus === "restarting" ||
    rawStatus === "connecting"
  );
}

/**
 * State-driven boot grace that stays active until the runtime has been
 * continuously fully-online for {@link STABLE_ONLINE_THRESHOLD_MS}, capped at
 * {@link BOOT_GRACE_MS} from the controller boot timestamp.
 *
 * While grace is active, channel `disconnected` states are softened to
 * `connecting` so users don't see alarming "disconnected" messages during the
 * normal OpenClaw startup window (which can take 2-3 min on Windows).
 */
export function useBootGrace(runtime: RuntimeReadySnapshot | undefined): {
  isFullyOnline: boolean;
  showBootGrace: boolean;
} {
  const isFullyOnline = isRuntimeFullyOnline(runtime);
  const [graceEnded, setGraceEnded] = useState(false);
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (graceEnded) return;

    if (stableTimerRef.current) {
      clearTimeout(stableTimerRef.current);
      stableTimerRef.current = null;
    }

    if (isFullyOnline) {
      stableTimerRef.current = setTimeout(() => {
        setGraceEnded(true);
      }, STABLE_ONLINE_THRESHOLD_MS);
    }

    return () => {
      if (stableTimerRef.current) {
        clearTimeout(stableTimerRef.current);
        stableTimerRef.current = null;
      }
    };
  }, [isFullyOnline, graceEnded]);

  useEffect(() => {
    if (graceEnded) return;
    if (typeof runtime?.bootTimestamp !== "number") return;

    const remaining = runtime.bootTimestamp + BOOT_GRACE_MS - Date.now();
    if (remaining <= 0) {
      setGraceEnded(true);
      return;
    }
    const timer = setTimeout(() => setGraceEnded(true), remaining);
    return () => clearTimeout(timer);
  }, [runtime?.bootTimestamp, graceEnded]);

  return {
    isFullyOnline,
    showBootGrace: !graceEnded,
  };
}

export function useChannelStatusWithHysteresis(
  rawStatus: ChannelLiveStatus | undefined,
  lastError: string | null,
): ChannelLiveStatus | undefined {
  const [displayStatus, setDisplayStatus] = useState(rawStatus);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (rawStatus === "connected" || rawStatus === "error" || lastError) {
      setDisplayStatus(rawStatus);
      return;
    }

    if (
      shouldDelayChannelStatusTransition(displayStatus, rawStatus, lastError)
    ) {
      timerRef.current = setTimeout(() => {
        setDisplayStatus(rawStatus);
        timerRef.current = null;
      }, CHANNEL_STATUS_HYSTERESIS_MS);
      return;
    }

    setDisplayStatus(rawStatus);
  }, [displayStatus, lastError, rawStatus]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return displayStatus;
}
