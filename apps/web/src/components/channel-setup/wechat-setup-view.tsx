import { identify, track } from "@/lib/tracking";
import { Loader2, QrCode, RefreshCw, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1ChannelsLiveStatus,
  postApiV1ChannelsWechatConnect,
  postApiV1ChannelsWechatQrStart,
  postApiV1ChannelsWechatQrWait,
} from "../../../lib/api/sdk.gen";

type Phase =
  | "idle"
  | "waiting-gateway"
  | "loading-qr"
  | "scanning"
  | "connecting"
  | "pending"
  | "error";

const RETRY_DELAY_MS = 2000;
const QR_START_MAX_WAIT_MS = 45_000;
const QR_LOGIN_MAX_WAIT_MS = 5 * 60_000;
const CONNECT_READY_MAX_WAIT_MS = 180_000;
const LIVE_STATUS_POLL_MS = 1500;

// Fake progress: gateway usually ready in 15-30s.
// We simulate 0→95% over ~40s with easing (fast→slow), then hold at 95%.
const PROGRESS_INTERVAL_MS = 400;
const PROGRESS_DURATION_MS = 40_000;

function isQrImageSource(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("data:image/");
}

function calcFakeProgress(elapsedMs: number): number {
  const ratio = Math.min(elapsedMs / PROGRESS_DURATION_MS, 1);
  // Ease-out: fast start, slow finish, caps at 95%
  return Math.round(95 * (1 - (1 - ratio) ** 2.5));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractApiMessage(error: unknown): string | null {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : null;
}

function shouldKeepPendingAccount(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    !normalized.includes("expired") &&
    !normalized.includes("qr") &&
    !message.includes("过期") &&
    !message.includes("二维码")
  );
}

export interface WechatSetupViewProps {
  onConnected: () => void;
  disabled?: boolean;
  /** When true, gateway is known to be running — skip "waiting gateway" hint. */
  gatewayReady?: boolean;
  showHeader?: boolean;
}

export function WechatSetupView({
  onConnected,
  disabled,
  gatewayReady,
  showHeader = true,
}: WechatSetupViewProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const progressStartRef = useRef(0);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startProgress = useCallback(() => {
    progressStartRef.current = Date.now();
    setProgress(0);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - progressStartRef.current;
      setProgress(calcFakeProgress(elapsed));
    }, PROGRESS_INTERVAL_MS);
  }, []);

  const stopProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const waitForWechatReady = useCallback(
    async (accountId: string, signal: AbortSignal) => {
      const deadline = Date.now() + CONNECT_READY_MAX_WAIT_MS;
      let consecutiveReadySamples = 0;

      while (!signal.aborted && Date.now() < deadline) {
        const { data } = await getApiV1ChannelsLiveStatus().catch(() => ({
          data: undefined,
        }));
        const wechat = data?.channels?.find(
          (channel) =>
            (channel.channelType === "wechat" ||
              channel.channelType === "wechat_personal") &&
            channel.accountId === accountId,
        );

        const freshReady =
          data?.gatewayConnected === true &&
          data?.system?.runtimeReady &&
          data.system.modelReady &&
          wechat?.ready &&
          wechat.status === "connected" &&
          wechat.stale !== true;

        if (freshReady) {
          consecutiveReadySamples += 1;
        } else {
          consecutiveReadySamples = 0;
        }

        if (consecutiveReadySamples >= 2) {
          return true;
        }

        await delay(LIVE_STATUS_POLL_MS);
      }

      return false;
    },
    [],
  );

  const confirmWechatAccount = useCallback(
    async (accountId: string, controller: AbortController) => {
      try {
        setQrUrl(null);
        setErrorMessage(null);
        setPhase("connecting");

        const { error: connectError } = await postApiV1ChannelsWechatConnect({
          body: { accountId },
        });

        if (controller.signal.aborted) return;

        if (connectError) {
          const msg =
            extractApiMessage(connectError) ?? t("wechatSetup.connectFailed");
          if (shouldKeepPendingAccount(msg)) {
            setErrorMessage(msg);
            setPhase("pending");
          } else {
            setErrorMessage(msg);
            setPhase("error");
          }
          return;
        }

        const ready = await waitForWechatReady(accountId, controller.signal);
        if (controller.signal.aborted) return;
        if (!ready) {
          setErrorMessage(t("wechatSetup.connectPending"));
          setPhase("pending");
          return;
        }

        toast.success(t("wechatSetup.connectSuccess"));
        track("channel_ready", {
          channel: "wechat",
          channel_type: "wechat_personal",
        });
        identify({ channels_connected: 1 });
        onConnected();
        setPhase("idle");
      } catch {
        if (!controller.signal.aborted) {
          setErrorMessage(t("wechatSetup.connectFailed"));
          setPhase("error");
        }
      }
    },
    [onConnected, t, waitForWechatReady],
  );

  const startQrFlow = useCallback(async () => {
    cleanup();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase(gatewayReady ? "loading-qr" : "waiting-gateway");
    setQrUrl(null);
    setErrorMessage(null);
    startProgress();
    const startedAt = Date.now();

    try {
      let startData: {
        qrDataUrl?: string;
        message: string;
        sessionKey?: string;
      } | null = null;

      // Retry for a bounded window until QR is obtained. Gateway/timeout errors are
      // transient (gateway still booting or plugin not loaded yet).
      // Only bail on genuinely unexpected errors or abort (panel closed).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (controller.signal.aborted) return;
        const { data, error } = await postApiV1ChannelsWechatQrStart();
        if (controller.signal.aborted) return;
        if (data?.qrDataUrl) {
          startData = data;
          break;
        }
        const errorMsg =
          error && typeof error === "object" && "message" in error
            ? String(error.message)
            : "";
        const isRetryable =
          errorMsg.toLowerCase().includes("gateway not connected") ||
          errorMsg.toLowerCase().includes("timed out") ||
          errorMsg === "";
        if (!isRetryable) {
          stopProgress();
          setErrorMessage(
            errorMsg || data?.message || t("wechatSetup.connectFailed"),
          );
          setPhase("error");
          return;
        }
        if (Date.now() - startedAt >= QR_START_MAX_WAIT_MS) {
          stopProgress();
          setErrorMessage(errorMsg || t("wechatSetup.timeout"));
          setPhase("error");
          return;
        }
        setPhase(gatewayReady ? "loading-qr" : "waiting-gateway");
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      stopProgress();
      if (!startData.sessionKey) {
        setErrorMessage(t("wechatSetup.connectFailed"));
        setPhase("error");
        return;
      }
      setQrUrl(startData.qrDataUrl ?? null);
      setPhase("scanning");
      const qrWaitStartedAt = Date.now();

      while (true) {
        if (controller.signal.aborted) return;

        const { data: waitData, error: waitError } =
          await postApiV1ChannelsWechatQrWait({
            body: { sessionKey: startData.sessionKey },
          });

        if (controller.signal.aborted) return;

        if (waitError || !waitData) {
          const msg =
            typeof waitError === "object" &&
            waitError !== null &&
            "message" in waitError
              ? String(waitError.message)
              : t("wechatSetup.timeout");
          setErrorMessage(msg);
          setPhase("error");
          return;
        }

        if (waitData.connected && waitData.accountId) {
          await confirmWechatAccount(waitData.accountId, controller);
          return;
        }

        if (
          waitData.expired ||
          Date.now() - qrWaitStartedAt >= QR_LOGIN_MAX_WAIT_MS
        ) {
          setErrorMessage(waitData.message || t("wechatSetup.timeout"));
          setPhase("error");
          return;
        }

        setPhase("scanning");
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    } catch {
      if (!abortRef.current?.signal.aborted) {
        stopProgress();
        setErrorMessage(t("wechatSetup.connectFailed"));
        setPhase("error");
      }
    }
  }, [
    confirmWechatAccount,
    cleanup,
    gatewayReady,
    startProgress,
    stopProgress,
    t,
  ]);

  const retryFlow = useCallback(() => {
    void startQrFlow();
  }, [startQrFlow]);

  const isLoading =
    phase === "waiting-gateway" ||
    phase === "loading-qr" ||
    phase === "scanning" ||
    phase === "connecting";

  return (
    <div
      className={
        showHeader ? "p-5 rounded-xl border bg-surface-1 border-border" : ""
      }
    >
      {showHeader && (
        <div className="flex gap-3 items-start mb-5">
          <div className="flex justify-center items-center w-9 h-9 rounded-lg bg-[var(--color-success-muted)] shrink-0">
            <Smartphone size={18} className="text-[var(--color-success)]" />
          </div>
          <div>
            <h3 className="text-[14px] font-semibold text-text-primary">
              {t("wechatSetup.title")}
            </h3>
            <p className="text-[12px] text-text-muted mt-1 leading-relaxed">
              {t("wechatSetup.desc")}
            </p>
          </div>
        </div>
      )}

      <div
        className={
          showHeader
            ? "flex flex-col items-center gap-4 py-4"
            : "flex flex-col items-center gap-3 py-1"
        }
      >
        {/* QR code display area */}
        {qrUrl && phase === "scanning" ? (
          <div className="flex flex-col items-center gap-3">
            <div className="p-3 bg-surface-1 rounded-xl shadow-sm border border-border">
              {isQrImageSource(qrUrl) ? (
                <img
                  src={qrUrl}
                  alt={t("wechatSetup.title")}
                  className="block w-[208px] h-[208px] object-contain"
                />
              ) : (
                <QRCodeSVG value={qrUrl} size={208} />
              )}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-success)]" />
              {t("wechatSetup.scanning")}
            </div>
            <p className="text-[11px] text-text-muted text-center max-w-xs leading-relaxed">
              {t("wechatSetup.scanHint")}
            </p>
          </div>
        ) : phase === "waiting-gateway" ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-success)]" />
            <span className="text-[12px] text-text-muted">
              {t("wechatSetup.waitingGateway")} {progress}%
            </span>
          </div>
        ) : phase === "loading-qr" ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-success)]" />
            <span className="text-[12px] text-text-muted">
              {t("wechatSetup.loadingQr")} {progress}%
            </span>
          </div>
        ) : phase === "connecting" ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-success)]" />
            <span className="text-[12px] text-text-muted">
              {t("wechatSetup.finalizing")}
            </span>
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/15">
              <QrCode size={48} className="text-red-400" />
            </div>
            <p className="text-[12px] text-red-500 text-center max-w-xs">
              {errorMessage}
            </p>
            <button
              type="button"
              onClick={retryFlow}
              className="flex gap-1.5 items-center px-4 py-2 text-[12px] font-medium text-accent-fg rounded-lg bg-accent hover:bg-accent-hover transition-all cursor-pointer"
            >
              <RefreshCw size={13} />
              {t("wechatSetup.retry")}
            </button>
          </div>
        ) : phase === "pending" ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="p-3 rounded-xl bg-[var(--color-warning-subtle)] border border-[rgba(251,191,36,0.18)]">
              <Loader2
                size={48}
                className="animate-spin text-[var(--color-warning)]"
              />
            </div>
            <p className="text-[12px] text-text-secondary text-center max-w-xs">
              {errorMessage}
            </p>
            <button
              type="button"
              onClick={retryFlow}
              className="flex gap-1.5 items-center px-4 py-2 text-[12px] font-medium text-accent-fg rounded-lg bg-accent hover:bg-accent-hover transition-all cursor-pointer"
            >
              <RefreshCw size={13} />
              {t("wechatSetup.retry")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-1">
            <div className="p-3 rounded-xl bg-[var(--color-success-subtle)] border border-[var(--color-success-border)]">
              <QrCode size={48} className="text-[var(--color-success)]" />
            </div>
            <button
              type="button"
              onClick={startQrFlow}
              disabled={disabled || isLoading}
              className="flex gap-1.5 items-center px-5 py-2.5 text-[13px] font-medium text-accent-fg rounded-lg bg-accent hover:bg-accent-hover transition-all disabled:opacity-60 cursor-pointer"
            >
              <QrCode size={14} />
              {t("wechatSetup.scanQr")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
