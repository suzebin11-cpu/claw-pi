import { ActivityFeed } from "@/components/activity-feed";
import { FeishuSetupView } from "@/components/channel-setup/feishu-setup-view";
import { QqbotSetupView } from "@/components/channel-setup/qqbot-setup-view";
import { TelegramSetupView } from "@/components/channel-setup/telegram-setup-view";
import { WechatSetupView } from "@/components/channel-setup/wechat-setup-view";
import { WhatsappSetupView } from "@/components/channel-setup/whatsapp-setup-view";
import { InlineModelSelector } from "@/components/inline-model-selector";
import { QqbotIcon, WechatIcon } from "@/components/platform-icons";
import { useOnboardingTour } from "@/hooks/use-onboarding-tour";
import { getChannelChatUrl } from "@/lib/channel-links";
import {
  type ChannelLiveStatus,
  resolveBootGraceChannelStatus,
  useBootGrace,
  useChannelStatusWithHysteresis,
} from "@/lib/runtime-startup";
import { normalizeChannel, track } from "@/lib/tracking";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Cable,
  Check,
  ChevronRight,
  Cpu,
  Loader2,
  MessageCircle,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import "@/lib/api";
import {
  deleteApiV1ChannelsByChannelId,
  getApiInternalDesktopReady,
  getApiV1Channels,
  getApiV1ChannelsLiveStatus,
  getApiV1Sessions,
} from "../../lib/api/sdk.gen";

type ChannelLiveStatusEntry = {
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
   * True when the controller is serving a previously cached status because
   * the gateway is transiently unreachable (e.g. WeChat first-message cold
   * start blocking the event loop for 60-120s). We keep the status pill as
   * it was and render a soft "syncing…" hint instead of flipping to
   * "connecting".
   */
  stale?: boolean;
};

type LiveStatusResponse = {
  gatewayConnected: boolean;
  channels: ChannelLiveStatusEntry[];
  agent: {
    modelId: string | null;
    modelName: string | null;
    alive: boolean;
  };
};

type DisconnectConfirmState = {
  channelId: string;
  channelType: string;
  channelName: string;
};

function formatRelativeTime(
  date: string | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!date) return t("home.noActivity");
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("home.justActive");
  if (minutes < 60) return t("home.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("home.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("home.daysAgo", { count: days });
}

const FEISHU_ICON = (
  <img
    width={16}
    height={16}
    alt="Feishu"
    src="/feishu-logo.png"
    style={{ objectFit: "contain" }}
  />
);

const QQBOT_SVG = <QqbotIcon size={18} />;
/** WeChat mark uses a wide viewBox; bump px so it matches visual weight of 16px square logos. */
type HomeChannelIconBox = "standard" | "compact";

function homeChannelIcon(
  ch: { id: string; icon?: ReactNode },
  box: HomeChannelIconBox = "standard",
) {
  if (ch.id === "wechat") {
    return <WechatIcon size={box === "compact" ? 22 : 36} />;
  }
  if (ch.id === "qqbot") {
    return <QqbotIcon size={box === "compact" ? 22 : 36} />;
  }
  if (ch.id === "feishu") {
    return (
      <img
        width={box === "compact" ? 22 : 36}
        height={box === "compact" ? 22 : 36}
        alt="Feishu"
        src="/feishu-logo.png"
        style={{ objectFit: "contain" }}
      />
    );
  }
  return ch.icon ?? null;
}

function getChannelOptions(t: (key: string) => string) {
  return [
    {
      id: "wechat",
      name: t("home.channel.wechat"),
      recommended: true,
    },
    {
      id: "qqbot",
      name: t("home.channel.qqbot"),
      icon: QQBOT_SVG,
      recommended: false,
    },
    {
      id: "feishu",
      name: t("home.channel.feishu"),
      icon: FEISHU_ICON,
      recommended: false,
    },
  ];
}

function getChannelStatusMeta(
  status: ChannelLiveStatus | undefined,
  t: (key: string) => string,
  lastError?: string | null,
): { colorClass: string; pulse: boolean; label: string } {
  switch (status) {
    case "connected":
      return {
        colorClass: "bg-[var(--color-success)]",
        pulse: false,
        label: t("home.connected"),
      };
    case "connecting":
      return {
        colorClass: "bg-[var(--color-warning)]",
        pulse: true,
        label: t("home.channelConnecting"),
      };
    case "restarting":
      return {
        colorClass: "bg-[var(--color-warning)]",
        pulse: true,
        label: t("home.channel.restarting"),
      };
    case "error": {
      const errorKey = lastError ? `home.channel.errorDetail.${lastError}` : "";
      const hasDetail = lastError && t(errorKey) !== errorKey;
      return {
        colorClass: hasDetail
          ? "bg-[var(--color-warning)]"
          : "bg-[var(--color-danger)]",
        pulse: false,
        label: hasDetail ? t(errorKey) : t("home.channel.error"),
      };
    }
    default:
      return {
        colorClass: "bg-text-muted/40",
        pulse: false,
        label: t("home.channel.disconnected"),
      };
  }
}

type ConnectedChannelRowProps = {
  channelOption: {
    id: string;
    name: string;
    icon?: ReactNode;
  };
  connectedChannel: {
    id: string;
    appId?: string | null;
    botUserId?: string | null;
    accountId: string;
  };
  statusEntry: ChannelLiveStatusEntry | undefined;
  isPendingChannel: boolean;
  showBootGrace: boolean;
  disconnectPending: boolean;
  onDisconnect: (state: DisconnectConfirmState) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
};

function ConnectedChannelRow({
  channelOption,
  connectedChannel,
  statusEntry,
  isPendingChannel,
  showBootGrace,
  disconnectPending,
  onDisconnect,
  t,
}: ConnectedChannelRowProps) {
  // Right after a successful connect (e.g. WeChat QR scan), the channel has
  // already been persisted to the controller config but OpenClaw hasn't had a
  // chance to surface it in `channels.status` yet — so the live-status API
  // returns no entry for it.  Without this fallback the UI would default to
  // "Disconnected" for a few seconds even though we know the channel is
  // freshly configured and coming up.  Treat the missing-entry case the same
  // as an explicit `connecting` state for any connected channel row.
  const rawStatus: ChannelLiveStatus | undefined = !statusEntry
    ? "connecting"
    : isPendingChannel && statusEntry.status === "disconnected"
      ? "connecting"
      : statusEntry.status;
  const graceAdjustedStatus = resolveBootGraceChannelStatus(
    rawStatus,
    showBootGrace,
  );
  const effectiveStatus = useChannelStatusWithHysteresis(
    graceAdjustedStatus,
    statusEntry?.lastError ?? null,
  );
  // During boot grace we replace the generic "connecting" label with a
  // first-launch specific one so users know the slow progress is expected.
  const statusLabelOverride =
    showBootGrace && effectiveStatus === "connecting"
      ? t("home.channel.firstLaunch")
      : undefined;
  const statusMeta = getChannelStatusMeta(
    effectiveStatus,
    t,
    statusEntry?.lastError,
  );
  const displayLabel = statusLabelOverride ?? statusMeta.label;
  const isConnectedLive = effectiveStatus === "connected";
  const isErrored = effectiveStatus === "error";
  // Sticky snapshot indicator: gateway is transiently unreachable but we're
  // preserving the last-known status so the pill doesn't jitter. Only render
  // this hint when the pill still shows "connected" — any other state already
  // communicates an in-progress condition on its own.
  const showSyncingHint = statusEntry?.stale === true && isConnectedLive;
  const channelChatUrl = getChannelChatUrl(
    channelOption.id,
    connectedChannel.appId,
    connectedChannel.botUserId,
    connectedChannel.accountId,
  );

  const handleOpenChannel = () => {
    const channel = normalizeChannel(channelOption.id);
    if (!channelChatUrl || !channel) {
      return;
    }
    track("workspace_chat_in_im_click", {
      channel,
      where: "home",
    });
    window.open(channelChatUrl, "_blank", "noopener,noreferrer");
  };

  const handleDisconnect = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDisconnect({
      channelId: connectedChannel.id,
      channelType: channelOption.id,
      channelName: channelOption.name,
    });
  };

  return (
    <div
      role={channelChatUrl ? "button" : undefined}
      tabIndex={channelChatUrl ? 0 : undefined}
      className="flex w-full items-center gap-3 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.03)] px-4 py-3 text-left transition-all hover:bg-[rgba(255,255,255,0.06)]"
      onClick={handleOpenChannel}
      onKeyDown={(event) => {
        if (!channelChatUrl) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleOpenChannel();
        }
      }}
    >
      <div className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0">
        {homeChannelIcon(channelOption)}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-text-primary truncate">
          {channelOption.name}
        </span>
      </div>
      {/*
        Status pill — read-only label showing the current connection state.
        Never a button; clicking it does nothing to prevent users from
        accidentally disconnecting a channel when it shows "Disconnected".
      */}
      <span
        title={statusEntry?.lastError ?? displayLabel}
        className="inline-flex items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-secondary shrink-0 select-none"
      >
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full ${statusMeta.colorClass} ${statusMeta.pulse ? "animate-pulse" : ""}`}
        />
        {displayLabel}
      </span>
      {showSyncingHint && (
        <span
          className="text-[11px] text-text-muted shrink-0 select-none"
          title={t("home.channel.syncingHint")}
        >
          {t("home.channel.syncing")}
        </span>
      )}
      {/*
        Disconnect action — only visible when the channel is actually
        connected or errored.  Icon-only to make it distinct from the pill
        and to signal a destructive action.
      */}
      {(isConnectedLive || isErrored) && (
        <button
          type="button"
          aria-label={t("home.disconnect")}
          title={t("home.disconnect")}
          onClick={handleDisconnect}
          disabled={disconnectPending}
          className="inline-flex items-center justify-center w-7 h-7 rounded-[8px] text-text-secondary hover:text-[var(--color-danger)] hover:bg-surface-3 transition-colors shrink-0 disabled:opacity-50"
        >
          {disconnectPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <X size={14} />
          )}
        </button>
      )}
      {channelOption.id !== "wechat" && channelChatUrl && (
        <a
          href={channelChatUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          onClickCapture={() => {
            const channel = normalizeChannel(channelOption.id);
            if (!channel) {
              return;
            }
            track("workspace_chat_in_im_click", {
              channel,
              where: "home",
            });
          }}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors ml-2 shrink-0 leading-none"
        >
          {t("home.chatInIm")}
          <ArrowUpRight size={12} className="-mt-px" />
        </a>
      )}
    </div>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const isDesktopClient = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron"),
    [],
  );
  const [wechatQrOpen, setWechatQrOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [qqbotOpen, setQqbotOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const queryClient = useQueryClient();
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);
  const [disconnectConfirm, setDisconnectConfirm] =
    useState<DisconnectConfirmState | null>(null);
  const connectingToastIdRef = useRef<string | number | null>(null);
  const previousLiveStatusesRef = useRef<Record<string, ChannelLiveStatus>>({});

  const CHANNEL_OPTIONS = useMemo(() => getChannelOptions(t), [t]);

  // Runtime health status (polls every 2s for faster feedback)
  const { data: runtimeData } = useQuery({
    queryKey: ["runtime-ready"],
    queryFn: async () => {
      const { data } = await getApiInternalDesktopReady();
      return data;
    },
    refetchInterval: 2000,
  });
  const { isFullyOnline, showBootGrace } = useBootGrace(runtimeData);

  const runtimeDisplay = useMemo(() => {
    if (!runtimeData) {
      return {
        label: t("home.status.starting"),
        subtitle: t("home.status.subtitle.starting"),
        color: "var(--color-warning)",
        pulse: true,
      } as const;
    }
    if (isFullyOnline) {
      return {
        label: t("home.running"),
        subtitle: null,
        color: "var(--color-success)",
        pulse: false,
      } as const;
    }
    if (showBootGrace) {
      return {
        label: t("home.status.starting"),
        subtitle: t("home.status.subtitle.starting"),
        color: "var(--color-warning)",
        pulse: true,
      } as const;
    }
    switch (runtimeData.status) {
      case "active":
      case "starting":
        return {
          label: t("home.status.starting"),
          subtitle: t("home.status.subtitle.starting"),
          color: "var(--color-warning)",
          pulse: true,
        } as const;
      case "degraded":
        return {
          label: t("home.status.degraded"),
          subtitle: t("home.status.subtitle.degraded"),
          color: "var(--color-warning)",
          pulse: true,
        } as const;
      case "unhealthy":
        return {
          label: t("home.status.offline"),
          subtitle: t("home.status.subtitle.offline"),
          color: "var(--color-danger)",
          pulse: true,
        } as const;
      default:
        return {
          label: t("home.status.starting"),
          subtitle: t("home.status.subtitle.starting"),
          color: "var(--color-warning)",
          pulse: true,
        } as const;
    }
  }, [isFullyOnline, runtimeData, showBootGrace, t]);

  const handleConnected = async () => {
    await queryClient.refetchQueries({ queryKey: ["channels"] });
    await queryClient.refetchQueries({ queryKey: ["channels-live-status"] });
  };

  const disconnectChannel = useMutation({
    mutationFn: async (channelId: string) => {
      const toastId = toast.loading(t("home.disconnecting"));
      const { error } = await deleteApiV1ChannelsByChannelId({
        path: { channelId },
      });
      if (error) {
        toast.error(t("home.disconnectFailed"), { id: toastId });
        throw new Error("Failed to disconnect channel");
      }
      toast.success(t("home.disconnected"), { id: toastId });
    },
    onSuccess: () => {
      setDisconnectConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
  });

  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data } = await getApiV1Channels();
      return data;
    },
  });

  const { data: sessionsData } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await getApiV1Sessions();
      return data;
    },
  });

  const sessions = sessionsData?.sessions ?? [];
  const { messagesToday, lastActiveAt } = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const msgCount = sessions.reduce((sum, s) => {
      const active = s.lastMessageAt && new Date(s.lastMessageAt) >= start;
      return sum + (active ? s.messageCount : 0);
    }, 0);
    const lastActive = sessions.reduce<string | null>((latest, s) => {
      if (!s.lastMessageAt) return latest;
      if (!latest) return s.lastMessageAt;
      return s.lastMessageAt > latest ? s.lastMessageAt : latest;
    }, null);
    return { messagesToday: msgCount, lastActiveAt: lastActive };
  }, [sessions]);

  const channels = channelsData?.channels ?? [];
  const activeChannels = channels.filter(
    (channel) => channel.status === "connected",
  );
  const connectedCount = activeChannels.length;
  const hasChannel = connectedCount > 0;
  const shouldPollLiveStatus = hasChannel || pendingChannelId !== null;
  const connectedTypes = new Set<string>(
    activeChannels.map((c) => c.channelType),
  );

  const { data: liveStatus } = useQuery({
    queryKey: ["channels-live-status"],
    queryFn: async () => {
      const { data } = await getApiV1ChannelsLiveStatus();
      console.log(
        "[home:live-status]",
        data?.gatewayConnected,
        data?.channels?.map(
          (c: { channelType: string; status: string }) =>
            `${c.channelType}=${c.status}`,
        ),
      );
      return data as LiveStatusResponse | undefined;
    },
    refetchInterval: shouldPollLiveStatus ? 3000 : false,
    enabled: shouldPollLiveStatus,
  });

  const liveStatusByChannelType = useMemo(() => {
    const entries = liveStatus?.channels ?? [];
    return new Map(entries.map((entry) => [entry.channelType, entry]));
  }, [liveStatus]);

  const liveStatusByChannelId = useMemo(() => {
    const entries = liveStatus?.channels ?? [];
    return new Map(entries.map((entry) => [entry.channelId, entry]));
  }, [liveStatus]);

  useEffect(() => {
    const toastId = connectingToastIdRef.current;
    if (!toastId || !pendingChannelId) {
      return;
    }
    const pending = liveStatusByChannelId.get(pendingChannelId);
    if (!pending) {
      toast.loading(t("home.channel.phase.configuring"), { id: toastId });
      return;
    }
    if (pending.status === "connected") {
      toast.success(t("home.channel.phase.done"), { id: toastId });
      connectingToastIdRef.current = null;
      setPendingChannelId(null);
      return;
    }
    if (pending.status === "error") {
      toast.error(pending.lastError ?? t("home.channel.error"), {
        id: toastId,
      });
      connectingToastIdRef.current = null;
      setPendingChannelId(null);
      return;
    }
    if (pending.status === "restarting") {
      toast.loading(t("home.channel.phase.configuring"), { id: toastId });
      return;
    }
    toast.loading(t("home.channel.phase.almostReady"), { id: toastId });
  }, [liveStatusByChannelId, pendingChannelId, t]);

  useEffect(() => {
    const previous = previousLiveStatusesRef.current;
    for (const entry of liveStatus?.channels ?? []) {
      const last = previous[entry.channelId];
      // Skip channels being tracked by the pending-channel toast above,
      // and suppress during the controller boot grace window.
      if (entry.channelId !== pendingChannelId && !showBootGrace) {
        if (last && last !== "connected" && entry.status === "connected") {
          toast.success(t("home.channel.phase.done"));
        }
      }
      previous[entry.channelId] = entry.status;
    }
  }, [liveStatus, pendingChannelId, showBootGrace, t]);

  useEffect(() => {
    const hasExpiredWechat = (liveStatus?.channels ?? []).some(
      (entry) =>
        entry.channelType === "wechat" &&
        entry.status === "error" &&
        entry.lastError === "session expired",
    );
    if (hasExpiredWechat) {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    }
  }, [liveStatus, queryClient]);

  /* ══════════════════════════════════════════════════════════════════════
     Scene A: First-run — Guided setup flow (no channels connected)
     ══════════════════════════════════════════════════════════════════════ */
  const systemReady = isFullyOnline;

  useOnboardingTour({
    enabled: !hasChannel && !channelsLoading && systemReady,
  });

  if (!hasChannel && !channelsLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
          {/* ═══ Welcome banner ═══ */}
          <div
            className="rounded-2xl px-8 py-8 mb-8 animate-gradient-shift"
            style={{
              background:
                "linear-gradient(135deg, rgba(61,185,206,0.12) 0%, rgba(100,60,180,0.08) 50%, rgba(61,185,206,0.06) 100%)",
              backgroundSize: "200% 200%",
              border: "1px solid rgba(61,185,206,0.1)",
            }}
          >
            <div className="flex items-center gap-5">
              <div className="relative w-16 h-16 shrink-0 rounded-xl overflow-hidden">
                <img
                  src="/claw-pi-avatar.png"
                  alt="Claw-Pi"
                  className="w-full h-full object-cover"
                />
              </div>
              <div>
                <h1 className="text-[26px] font-extrabold tracking-tight text-text-heading">
                  {t("home.guide.welcome")}
                </h1>
                <p className="mt-1 text-[15px] text-text-secondary leading-relaxed">
                  {t("home.guide.welcomeDesc")}
                </p>
              </div>
            </div>
          </div>

          {/* ═══ Step flow ═══ */}
          <div className="space-y-5">
            {/* ── Step 1: System check ── */}
            <div className="card card-static px-6 py-5">
              <div className="flex items-start gap-4">
                <div
                  className={`guide-step-number ${systemReady ? "guide-step-number-done" : "guide-step-number-active"}`}
                >
                  {systemReady ? <Check size={18} strokeWidth={3} /> : "1"}
                </div>
                <div className="flex-1 min-w-0 pt-1">
                  <h3 className="text-[16px] font-bold text-text-heading">
                    {t("home.guide.step1.title")}
                  </h3>
                  <div className="mt-2 flex items-center gap-2.5">
                    {systemReady ? (
                      <>
                        <span className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-success-subtle)] text-[var(--color-success)] text-[13px] font-semibold">
                          <span className="w-2 h-2 rounded-full bg-[var(--color-success)]" />
                          {t("home.guide.step1.ready")}
                        </span>
                        <span className="text-[13px] text-text-secondary">
                          {t("home.guide.step1.readyDesc")}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-warning-subtle)] text-[var(--color-warning)] text-[13px] font-semibold">
                          <Loader2 size={14} className="animate-spin" />
                          {t("home.guide.step1.starting")}
                        </span>
                        <span className="text-[13px] text-text-muted">
                          {t("home.guide.step1.startingDesc")}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <Cpu size={20} className="text-text-muted shrink-0 mt-2" />
              </div>
            </div>

            {/* ── Step 2: Connect channel ── */}
            <div
              id="guide-channel-cards"
              className={`card card-static px-6 py-5 transition-opacity ${!systemReady ? "opacity-60" : ""}`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`guide-step-number ${systemReady ? "guide-step-number-active" : "guide-step-number-pending"}`}
                >
                  2
                </div>
                <div className="flex-1 min-w-0 pt-1">
                  <h3 className="text-[16px] font-bold text-text-heading">
                    {t("home.guide.step2.title")}
                  </h3>
                  <p className="mt-1 text-[13px] text-text-secondary">
                    {t("home.guide.step2.desc")}
                  </p>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {CHANNEL_OPTIONS.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        disabled={!systemReady}
                        onClick={() => {
                          if (ch.id === "wechat") {
                            setWechatQrOpen(true);
                          } else if (ch.id === "qqbot") {
                            setQqbotOpen(true);
                          } else if (ch.id === "feishu") {
                            setFeishuOpen(true);
                          }
                        }}
                        className={`group relative rounded-xl border-2 px-4 py-4 text-left transition-all cursor-pointer active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
                          ch.id === "wechat"
                            ? "border-[var(--color-brand-primary)] bg-[rgba(61,185,206,0.08)] hover:bg-[rgba(61,185,206,0.14)] shadow-[0_0_20px_rgba(61,185,206,0.1)]"
                            : "border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.12)] hover:bg-[rgba(255,255,255,0.06)]"
                        }`}
                      >
                        {ch.id === "wechat" && (
                          <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-brand-primary)] text-white">
                            {t("home.guide.step2.recommended")}
                          </span>
                        )}
                        <div className="flex flex-col items-center text-center gap-3">
                          <div className="w-12 h-12 rounded-xl flex items-center justify-center">
                            {homeChannelIcon(ch)}
                          </div>
                          <div>
                            <div className="text-[14px] font-semibold text-text-primary">
                              {ch.name}
                            </div>
                            <div className="mt-0.5 text-[12px] text-text-muted">
                              {t("home.channel.addBot")}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 text-[12px] font-medium text-[var(--color-brand-primary)]">
                            <Cable size={12} />
                            {t("home.connect")}
                            <ChevronRight size={12} />
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Step 3: Start using ── */}
            <div className="card card-static px-6 py-5 opacity-50">
              <div className="flex items-start gap-4">
                <div className="guide-step-number guide-step-number-pending">
                  3
                </div>
                <div className="flex-1 min-w-0 pt-1">
                  <h3 className="text-[16px] font-bold text-text-heading">
                    {t("home.guide.step3.title")}
                  </h3>
                  <p className="mt-1 text-[13px] text-text-secondary leading-relaxed">
                    {t("home.guide.step3.desc")}
                  </p>
                </div>
                <MessageCircle
                  size={20}
                  className="text-text-muted shrink-0 mt-2"
                />
              </div>
            </div>
          </div>
        </div>

        {wechatQrOpen && (
          <WechatQrModal
            onClose={() => setWechatQrOpen(false)}
            onConnected={() => {
              setWechatQrOpen(false);
              handleConnected();
            }}
            gatewayReady={isFullyOnline}
          />
        )}

        {telegramOpen && (
          <TelegramModal
            onClose={() => setTelegramOpen(false)}
            onConnected={() => {
              setTelegramOpen(false);
              void handleConnected();
            }}
          />
        )}

        {whatsappOpen && (
          <WhatsappModal
            onClose={() => setWhatsappOpen(false)}
            onConnected={() => {
              setWhatsappOpen(false);
              void handleConnected();
            }}
          />
        )}

        {qqbotOpen && (
          <QqbotModal
            onClose={() => setQqbotOpen(false)}
            onConnected={() => {
              setQqbotOpen(false);
              void handleConnected();
            }}
          />
        )}

        {feishuOpen && (
          <FeishuModal
            onClose={() => setFeishuOpen(false)}
            onConnected={() => {
              setFeishuOpen(false);
              void handleConnected();
            }}
          />
        )}
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     Scene B: Operational — Channels connected (Running state)
     ══════════════════════════════════════════════════════════════════════ */
  return (
    <div className="h-full overflow-y-auto">
      <div
        className="max-w-3xl mx-auto px-4 sm:px-6 pb-6 sm:pb-8 space-y-6"
        style={{ paddingTop: isDesktopClient ? "2rem" : "1.5rem" }}
      >
        {/* ═══ TOP: Status dashboard card ═══ */}
        <div
          className="card card-static relative z-10"
          style={{
            background:
              "linear-gradient(135deg, rgba(61,185,206,0.1) 0%, rgba(255,255,255,0.03) 60%)",
          }}
        >
          <div className="px-6 py-5">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <span
                  className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${runtimeDisplay.color} 12%, transparent)`,
                    color: runtimeDisplay.color,
                  }}
                >
                  {runtimeDisplay.pulse ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: runtimeDisplay.color }}
                    />
                  )}
                  {runtimeDisplay.label}
                </span>
                {runtimeDisplay.subtitle && (
                  <span className="text-[11px] text-text-muted">
                    {runtimeDisplay.subtitle}
                  </span>
                )}
                <InlineModelSelector />
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] px-4 py-3 text-center flex flex-col">
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-[22px] font-bold text-text-heading tabular-nums">
                    {sessionsData ? messagesToday : "—"}
                  </span>
                </div>
                <div className="text-[12px] text-text-muted mt-0.5">
                  {t("home.todayMessages", {
                    count: sessionsData ? messagesToday : 0,
                  })}
                </div>
              </div>
              <div className="rounded-xl bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] px-4 py-3 text-center flex flex-col">
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-[22px] font-bold text-text-heading tabular-nums">
                    {connectedCount}
                  </span>
                </div>
                <div className="text-[12px] text-text-muted mt-0.5">
                  {t("home.channelsTitle")}
                </div>
              </div>
              <div className="rounded-xl bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] px-4 py-3 text-center flex flex-col">
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-[14px] font-bold text-text-heading">
                    {sessionsData ? formatRelativeTime(lastActiveAt, t) : "..."}
                  </span>
                </div>
                <div className="text-[12px] text-text-muted mt-0.5">
                  {t("home.recentActivity")}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ═══ MIDDLE: Channels panel ═══ */}
        <div className="card card-static">
          <div className="px-6 pt-5 pb-3">
            <h2 className="text-[16px] font-bold text-text-heading">
              {t("home.channelsTitle")}
            </h2>
          </div>
          <div className="px-6 pb-5 space-y-3">
            {/* Connected channels — full width rows with green dot */}
            {CHANNEL_OPTIONS.filter((ch) => connectedTypes.has(ch.id)).length >
              0 && (
              <div className="space-y-1.5">
                {CHANNEL_OPTIONS.filter((ch) => connectedTypes.has(ch.id)).map(
                  (ch) => {
                    const connectedChannel = activeChannels.find(
                      (c) => c.channelType === ch.id,
                    );
                    if (!connectedChannel) {
                      return null;
                    }
                    const statusEntry = connectedChannel
                      ? liveStatusByChannelId.get(connectedChannel.id)
                      : liveStatusByChannelType.get(ch.id);
                    return (
                      <ConnectedChannelRow
                        key={ch.id}
                        channelOption={ch}
                        connectedChannel={connectedChannel}
                        statusEntry={statusEntry}
                        isPendingChannel={
                          connectedChannel.id === pendingChannelId
                        }
                        showBootGrace={showBootGrace}
                        disconnectPending={disconnectChannel.isPending}
                        onDisconnect={setDisconnectConfirm}
                        t={t}
                      />
                    );
                  },
                )}
              </div>
            )}

            {/* Not-yet-connected channels — dashed border grid */}
            {CHANNEL_OPTIONS.filter((ch) => !connectedTypes.has(ch.id)).length >
              0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {CHANNEL_OPTIONS.filter((ch) => !connectedTypes.has(ch.id)).map(
                  (ch) => (
                    <button
                      key={ch.id}
                      type="button"
                      disabled={!systemReady}
                      onClick={() => {
                        const channel = normalizeChannel(ch.id);
                        if (channel) {
                          track("workspace_channel_connect_click", { channel });
                        }
                        if (ch.id === "wechat") {
                          setWechatQrOpen(true);
                        } else if (ch.id === "qqbot") {
                          setQqbotOpen(true);
                        } else if (ch.id === "feishu") {
                          setFeishuOpen(true);
                        }
                      }}
                      className="group flex items-center gap-2.5 rounded-lg border border-dashed border-border bg-surface-0 px-3 py-2 text-left hover:border-solid hover:border-border-hover hover:bg-surface-1 transition-all disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0">
                        {homeChannelIcon(ch, "compact")}
                      </div>
                      <span className="text-[12px] font-medium text-text-muted group-hover:text-text-secondary flex-1 truncate">
                        {ch.name}
                      </span>
                      <Cable
                        size={12}
                        className="text-text-muted group-hover:text-text-primary transition-colors shrink-0"
                      />
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        </div>

        {/* Activity Feed */}
        <ActivityFeed />
      </div>

      {wechatQrOpen && (
        <WechatQrModal
          onClose={() => setWechatQrOpen(false)}
          onConnected={() => {
            setWechatQrOpen(false);
            handleConnected();
          }}
          gatewayReady={isFullyOnline}
        />
      )}

      {telegramOpen && (
        <TelegramModal
          onClose={() => setTelegramOpen(false)}
          onConnected={() => {
            setTelegramOpen(false);
            void handleConnected();
          }}
        />
      )}

      {whatsappOpen && (
        <WhatsappModal
          onClose={() => setWhatsappOpen(false)}
          onConnected={() => {
            setWhatsappOpen(false);
            void handleConnected();
          }}
        />
      )}

      {qqbotOpen && (
        <QqbotModal
          onClose={() => setQqbotOpen(false)}
          onConnected={() => {
            setQqbotOpen(false);
            void handleConnected();
          }}
        />
      )}

      {feishuOpen && (
        <FeishuModal
          onClose={() => setFeishuOpen(false)}
          onConnected={() => {
            setFeishuOpen(false);
            void handleConnected();
          }}
        />
      )}

      {disconnectConfirm && (
        <DisconnectConfirmModal
          channelName={disconnectConfirm.channelName}
          onClose={() => {
            if (!disconnectChannel.isPending) {
              setDisconnectConfirm(null);
            }
          }}
          onConfirm={() => {
            const channel = normalizeChannel(disconnectConfirm.channelType);
            track("workspace_channel_disconnect_click", {
              channel: channel ?? disconnectConfirm.channelType,
            });
            disconnectChannel.mutate(disconnectConfirm.channelId);
          }}
          isPending={disconnectChannel.isPending}
        />
      )}
    </div>
  );
}

// ─── WeChat QR Modal ──────────────────────────────────────

function WechatQrModal({
  onClose,
  onConnected,
  gatewayReady,
}: {
  onClose: () => void;
  onConnected: () => void;
  gatewayReady?: boolean;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: custom modal without native dialog */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md mx-4 rounded-2xl border border-border bg-surface-0 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex min-w-0 flex-1 items-center gap-3 pr-2">
            <div className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center">
              <WechatIcon size={24} />
            </div>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-text-primary">
                {t("wechatSetup.title")}
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-text-muted line-clamp-1">
                {t("wechatSetup.desc")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 pt-1 pb-5">
          <WechatSetupView
            onConnected={onConnected}
            gatewayReady={gatewayReady}
            showHeader={false}
          />
        </div>
      </div>
    </div>
  );
}

function useModalDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const getFocusableElements = () => {
      const dialog = dialogRef.current;
      if (!dialog) {
        return [] as HTMLElement[];
      }
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
    };

    const getFocusBoundary = () => {
      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        return null;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (!firstElement || !lastElement) {
        return null;
      }

      return { firstElement, lastElement };
    };

    const focusableElements = getFocusableElements();
    const initialFocusTarget = focusableElements[0] ?? dialogRef.current;
    initialFocusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusBoundary = getFocusBoundary();
      if (!focusBoundary) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const { firstElement, lastElement } = focusBoundary;
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (event.shiftKey) {
        if (
          activeElement === firstElement ||
          activeElement === dialogRef.current
        ) {
          event.preventDefault();
          lastElement.focus();
        }
        return;
      }

      if (activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [onClose]);

  return dialogRef;
}

function TelegramModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useModalDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <dialog
        open
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[560px] rounded-2xl border border-border bg-surface-1 shadow-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div
            id={titleId}
            className="text-[14px] font-semibold text-text-primary"
          >
            {t("telegramSetup.title")}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.closeDialog")}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <TelegramSetupView onConnected={onConnected} />
        </div>
      </dialog>
    </div>
  );
}

function WhatsappModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useModalDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <dialog
        open
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[560px] rounded-2xl border border-border bg-surface-1 shadow-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div
            id={titleId}
            className="text-[14px] font-semibold text-text-primary"
          >
            {t("whatsappSetup.title")}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.closeDialog")}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <WhatsappSetupView onConnected={onConnected} />
        </div>
      </dialog>
    </div>
  );
}

function QqbotModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useModalDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <dialog
        open
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[560px] rounded-2xl border border-border bg-surface-1 shadow-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div
            id={titleId}
            className="text-[14px] font-semibold text-text-primary"
          >
            {t("qqbotSetup.title")}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.closeDialog")}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <QqbotSetupView onConnected={onConnected} />
        </div>
      </dialog>
    </div>
  );
}

function FeishuModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useModalDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <dialog
        open
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[560px] rounded-2xl border border-border bg-surface-1 shadow-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div
            id={titleId}
            className="text-[14px] font-semibold text-text-primary"
          >
            {t("feishuSetup.title")}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.closeDialog")}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          <FeishuSetupView onConnected={onConnected} variant="modal" />
        </div>
      </dialog>
    </div>
  );
}

function DisconnectConfirmModal({
  channelName,
  onClose,
  onConfirm,
  isPending,
}: {
  channelName: string;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useModalDialog(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss is supplementary to Escape key */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => {
          if (!isPending) {
            onClose();
          }
        }}
      />
      <dialog
        open
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[420px] rounded-2xl border border-border bg-surface-1 shadow-xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 shrink-0">
              <X size={14} className="text-red-500" />
            </div>
            <div>
              <h3
                id={titleId}
                className="text-[14px] font-semibold text-text-primary"
              >
                {t("home.confirmDisconnect.title", {
                  platform: channelName,
                })}
              </h3>
              <p className="text-[11px] text-text-muted mt-0.5">
                {t("home.confirmDisconnect.subtitle", {
                  platform: channelName,
                })}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-[12px] text-text-secondary leading-relaxed">
            {t("home.confirmDisconnect.body", {
              platform: channelName,
            })}
          </p>
          <div className="mt-4 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="px-3.5 py-2 text-[12px] font-medium text-text-secondary rounded-lg border border-border hover:border-border-hover hover:bg-surface-3 transition-all disabled:opacity-60"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium text-white rounded-lg bg-red-500 hover:bg-red-600 transition-all disabled:opacity-60"
            >
              {isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X size={12} />
              )}
              {t("home.confirmDisconnect.confirm")}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
