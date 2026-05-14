import { PlatformIcon } from "@/components/platform-icons";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { useCommunitySkills } from "@/hooks/use-community-catalog";
import { type Locale, useLocale } from "@/hooks/use-locale";
import { authClient } from "@/lib/auth-client";
import { useBootGrace } from "@/lib/runtime-startup";
import { normalizeChannel, track } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronUp,
  CircleHelp,
  Cpu,
  Globe,
  Home,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  QrCode,
  Settings,
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import "@/lib/api";
import { toast } from "sonner";
import {
  getApiInternalDesktopReady,
  getApiV1Me,
  getApiV1Sessions,
  postApiInternalActivationLogout,
} from "../../lib/api/sdk.gen";

interface SidebarSession {
  id: string;
  title: string;
  channelType: string;
  lastTime: string | null;
  status: string;
}

function mapDbSession(s: {
  id: string;
  title: string;
  channelType?: string | null;
  lastMessageAt?: string | null;
  updatedAt?: string;
  status?: string | null;
}): SidebarSession {
  return {
    id: s.id,
    title: s.title,
    channelType: s.channelType ?? "web",
    lastTime: s.lastMessageAt ?? s.updatedAt ?? null,
    status: s.status ?? "",
  };
}

type Platform =
  | "slack"
  | "discord"
  | "whatsapp"
  | "telegram"
  | "feishu"
  | "wechat"
  | "openclaw-weixin"
  | "web";

const PLATFORM_LABELS: Record<Platform, string> = {
  discord: "Discord",
  slack: "Slack",
  feishu: "Feishu",
  wechat: "WeChat",
  "openclaw-weixin": "WeChat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  web: "Web",
};

function SidebarPlatformIcon({ platform }: { platform: string }) {
  return (
    <span className="flex justify-center items-center w-7 h-7 rounded-xl border border-border bg-surface-1 shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <PlatformIcon platform={platform} size={15} />
    </span>
  );
}

function getPlatformLabel(
  platform: string,
  t: (key: string) => string,
): string {
  const mapped = platform === "openclaw-weixin" ? "wechat" : platform;
  const key = `home.channel.${mapped}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return PLATFORM_LABELS[platform as Platform] ?? t("home.channel.web");
}

function formatTime(
  iso: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("layout.timeJustNow");
  if (diffMin < 60) return t("layout.timeMinutesAgo", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("layout.timeHoursAgo", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t("layout.timeDaysAgo", { count: diffDay });
  return d.toLocaleDateString();
}

function EmptyState({ onGoConfig }: { onGoConfig: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col justify-center items-center h-full px-8">
      <div className="max-w-md text-center">
        <div className="flex justify-center items-center mx-auto mb-6 w-16 h-16 rounded-2xl bg-accent/10">
          <MessageSquare size={28} className="text-accent" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-text-primary">
          {t("layout.empty.title")}
        </h2>
        <p className="mb-6 text-sm leading-relaxed text-text-muted">
          {t("layout.empty.description")}
        </p>
        <div className="flex flex-col gap-3 items-center">
          <button
            type="button"
            onClick={onGoConfig}
            className="flex gap-2 items-center px-6 py-2.5 text-sm font-medium text-white rounded-lg transition-colors bg-accent hover:bg-accent-hover"
          >
            <Settings size={14} /> {t("layout.empty.setupBot")}
          </button>
          <div className="flex gap-4 mt-2">
            {[
              { step: "1", text: t("layout.empty.step1") },
              { step: "2", text: t("layout.empty.step2") },
              { step: "3", text: t("layout.empty.step3") },
            ].map((s, i) => (
              <div
                key={s.step}
                className="flex gap-1.5 items-center text-[12px] text-text-muted"
              >
                {i > 0 && <span className="text-border mr-1">→</span>}
                <span className="flex justify-center items-center w-4 h-4 rounded-full bg-accent/10 text-[10px] font-semibold text-accent">
                  {s.step}
                </span>
                {s.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LanguageToggle({ collapsed }: { collapsed: boolean }) {
  const { locale, setLocale } = useLocale();
  const nextLocale: Locale = locale === "en" ? "zh" : "en";
  const label = locale === "en" ? "中文" : "EN";

  return (
    <div className={cn(collapsed ? "px-2" : "px-3", "pb-1")}>
      <button
        type="button"
        onClick={() => setLocale(nextLocale)}
        title={locale === "en" ? "切换到中文" : "Switch to English"}
        className={cn(
          "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors cursor-pointer",
          collapsed ? "justify-center p-2" : "px-3 py-2",
        )}
      >
        <Globe size={14} />
        {!collapsed && label}
      </button>
    </div>
  );
}

const SETUP_COMPLETE_KEY = "nexu_setup_complete";

interface UpdateFloatCardProps {
  phase: ReturnType<typeof useAutoUpdate>["phase"];
  version: string | null;
  percent: number;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
  t: (key: string, options?: Record<string, string>) => string;
  desktopOffsetLeft: number;
  desktopOffsetBottom: number;
  width: number;
}

function UpdateFloatCard({
  phase,
  version,
  percent,
  onDownload,
  onInstall,
  onDismiss,
  t,
  desktopOffsetLeft,
  desktopOffsetBottom,
  width,
}: UpdateFloatCardProps) {
  const updating = phase === "downloading";
  const downloadProgress = Math.round(percent);

  if (phase !== "available" && phase !== "downloading" && phase !== "ready") {
    return null;
  }

  return (
    <div
      className="fixed z-50 rounded-[14px] border border-border bg-surface-0/88 px-3.5 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.16)] backdrop-blur-md animate-float"
      style={
        {
          left: desktopOffsetLeft,
          bottom: desktopOffsetBottom,
          width,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative mt-0.5 flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-success)] opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-success)]" />
            </span>
            <span className="text-[12px] font-medium text-text-primary">
              {updating
                ? t("layout.update.downloading")
                : phase === "ready"
                  ? t("layout.update.readyToInstall")
                  : t("layout.update.available", {
                      version: version ?? "",
                    })}
            </span>
          </div>
        </div>
        {!updating && phase !== "ready" && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-text-muted hover:text-text-primary transition-colors -mr-1"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {updating && (
        <div className="flex items-center justify-between mt-3 mb-1">
          <span className="text-[10px] tabular-nums text-text-muted">
            {downloadProgress}%
          </span>
        </div>
      )}
      {updating ? (
        <div>
          <div className="h-[6px] w-full rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--color-brand-primary)] transition-all duration-300 ease-out"
              style={{ width: `${downloadProgress}%` }}
            />
          </div>
        </div>
      ) : phase === "ready" ? (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onInstall}
            className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium bg-[var(--color-accent)] text-white hover:opacity-85 transition-opacity"
          >
            {t("layout.update.install")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onDownload}
            className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium bg-[var(--color-accent)] text-white hover:opacity-85 transition-opacity"
          >
            {t("layout.update.download")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            {t("layout.update.later")}
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceLayout() {
  if (localStorage.getItem(SETUP_COMPLETE_KEY) !== "1") {
    return <Navigate to="/" replace />;
  }

  return <WorkspaceLayoutInner />;
}

function WorkspaceLayoutInner() {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const isDesktopClient = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron"),
    [],
  );
  const isMacDesktop = useMemo(
    () => isDesktopClient && navigator.platform?.startsWith("Mac"),
    [isDesktopClient],
  );
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [showQrPopover, setShowQrPopover] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const update = useAutoUpdate();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const hasUpdate =
    update.phase === "available" ||
    update.phase === "downloading" ||
    update.phase === "ready";
  const SIDEBAR_MIN = 160;
  const SIDEBAR_MAX = 320;
  const SIDEBAR_DEFAULT = 192;
  const MAIN_MIN = 480;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("nexu_sidebar_width");
    return saved
      ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved)))
      : SIDEBAR_DEFAULT;
  });
  const isResizing = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const containerWidth = window.innerWidth;
        const newW = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)),
        );
        if (containerWidth - newW >= MAIN_MIN) {
          setSidebarWidth(newW);
        }
      };

      const onUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setSidebarWidth((w) => {
          localStorage.setItem("nexu_sidebar_width", String(w));
          return w;
        });
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const logoutRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const { data: skillsData } = useCommunitySkills();
  const installedSkillsCount = skillsData?.installedSkills?.length ?? 0;

  useEffect(() => {
    if (!isMacDesktop) {
      return;
    }

    const root = document.getElementById("root");
    const previousHtmlBackground =
      document.documentElement.style.backgroundColor;
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousRootBackground = root?.style.backgroundColor ?? "";
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    if (root) {
      root.style.backgroundColor = "transparent";
    }

    return () => {
      document.documentElement.style.backgroundColor = previousHtmlBackground;
      document.body.style.backgroundColor = previousBodyBackground;
      if (root) {
        root.style.backgroundColor = previousRootBackground;
      }
    };
  }, [isMacDesktop]);

  useEffect(() => {
    if (!showLogoutConfirm) return;
    const handler = (e: MouseEvent) => {
      if (logoutRef.current && !logoutRef.current.contains(e.target as Node)) {
        setShowLogoutConfirm(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showLogoutConfirm]);

  useEffect(() => {
    if (!showHelpMenu) return;
    const handler = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        setShowHelpMenu(false);
        setShowQrPopover(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showHelpMenu]);

  useEffect(() => {
    if (!showHelpMenu) {
      setShowQrPopover(false);
    }
  }, [showHelpMenu]);

  useEffect(() => {
    if (!showLangMenu) return;
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setShowLangMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showLangMenu]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [mobileDrawerOpen]);

  const { data: sessionsData } = useQuery({
    queryKey: ["sidebar-sessions"],
    queryFn: async (): Promise<SidebarSession[]> => {
      const { data } = await getApiV1Sessions({ query: { limit: 100 } });
      return (data?.sessions ?? []).map(mapDbSession);
    },
    refetchInterval: 10_000,
  });
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data } = await getApiV1Me();
      return data;
    },
  });

  const { data: runtimeStatus } = useQuery({
    queryKey: ["sidebar-runtime-status"],
    queryFn: async () => {
      const { data } = await getApiInternalDesktopReady();
      return data;
    },
    refetchInterval: 5_000,
  });
  const {
    isFullyOnline: isRuntimeFullyOnline,
    showBootGrace: showRuntimeBootGrace,
  } = useBootGrace(runtimeStatus);

  const handleOpenRuntime = useCallback(() => {
    track("workspace_runtime_click");
    track("workspace_sidebar_click", { target: "runtime" });
    if (isRuntimeFullyOnline) {
      const url =
        runtimeStatus?.openclawChatUrl ?? "http://127.0.0.1:18789/chat";
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      toast.info(t("layout.runtimeNotReady"));
    }
  }, [isRuntimeFullyOnline, runtimeStatus, t]);

  const sessions = sessionsData ?? [];

  const sessionMatch = location.pathname.match(/\/workspace\/sessions\/(.+)/);
  const selectedSessionId = sessionMatch?.[1] ?? null;
  const isHomePage =
    location.pathname === "/workspace" ||
    location.pathname === "/workspace/home";
  const isSkillsPage = location.pathname.includes("/skills");
  const isRechargePage = location.pathname.includes("/recharge");
  const isModelsPage = location.pathname.includes("/models");
  const isSettingsPage = location.pathname.includes("/settings");

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    track("workspace_logout_click");
    if (isDesktopClient) {
      await postApiInternalActivationLogout();
      localStorage.removeItem(SETUP_COMPLETE_KEY);
      window.location.href = "/";
    } else {
      await authClient.signOut();
      window.location.href = "/";
    }
  };

  const userEmail = me?.email ?? session?.user?.email ?? "";
  const userName = me?.name?.trim() || session?.user?.name || userEmail;
  const userImage = me?.image ?? session?.user?.image ?? null;
  const userInitial = (userName[0] ?? userEmail[0] ?? "U").toUpperCase();

  const showEmptyState =
    sessions.length === 0 &&
    !isHomePage &&
    !isSkillsPage &&
    !isRechargePage &&
    !isModelsPage &&
    !isSettingsPage &&
    !selectedSessionId;

  const selectedSession = selectedSessionId
    ? sessions.find((s) => s.id === selectedSessionId)
    : null;
  const mobileTitle = isHomePage
    ? t("layout.mobile.home")
    : isSkillsPage
      ? t("layout.mobile.skills")
      : isRechargePage
        ? t("layout.mobile.recharge")
        : isModelsPage
          ? t("layout.mobile.models")
          : isSettingsPage
            ? t("layout.mobile.settings")
            : selectedSession?.title || t("layout.mobile.conversations");
  const mobileSubtitle = isHomePage
    ? t("layout.mobile.homeSubtitle")
    : isSkillsPage
      ? t("layout.mobile.skillsSubtitle")
      : isRechargePage
        ? t("layout.mobile.rechargeSubtitle")
        : isModelsPage
          ? t("layout.mobile.modelsSubtitle")
          : isSettingsPage
            ? t("layout.mobile.settingsSubtitle")
            : selectedSession
              ? `${getPlatformLabel(selectedSession.channelType, t)} · ${formatTime(selectedSession.lastTime, t)}`
              : t("layout.mobileConversationCount", { count: sessions.length });
  const desktopGlassTint = isMacDesktop
    ? "rgba(255, 255, 255, 0.08)"
    : "var(--color-surface-0)";
  const updateFloatWidth = Math.max(140, sidebarWidth - 20);
  const updateFloatLeft = 10;
  const updateFloatBottom = 52;

  return (
    <div className="relative flex h-screen overflow-hidden bg-surface-0">
      {isDesktopClient && hasUpdate && !updateDismissed && (
        <UpdateFloatCard
          phase={update.phase}
          version={update.version}
          percent={update.percent}
          onDownload={() => update.download()}
          onInstall={() => update.install()}
          onDismiss={() => setUpdateDismissed(true)}
          t={t}
          desktopOffsetLeft={updateFloatLeft}
          desktopOffsetBottom={updateFloatBottom}
          width={updateFloatWidth}
        />
      )}

      {/* Fixed sidebar toggle */}
      {(isDesktopClient || collapsed) && (
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "fixed p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-3 transition-colors hidden md:flex items-center justify-center z-50",
            collapsed ? "top-[12px] left-[12px]" : "top-[12px] left-[80px]",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={
            collapsed ? t("layout.expandSidebar") : t("layout.collapseSidebar")
          }
        >
          {collapsed ? (
            <PanelLeftOpen size={16} />
          ) : (
            <PanelLeftClose size={16} />
          )}
        </button>
      )}

      {/* Desktop sidebar — transparent bg, no border (matches design-system) */}
      <div
        className={`hidden md:flex flex-col shrink-0 overflow-hidden ${collapsed ? "w-0" : ""}`}
        style={
          {
            ...(!collapsed ? { width: sidebarWidth } : {}),
            transition: isResizing.current ? "none" : "width 200ms",
            WebkitAppRegion: "drag",
            background: isDesktopClient ? desktopGlassTint : "transparent",
          } as React.CSSProperties
        }
      >
        {/* Traffic light clearance (desktop client) */}
        {isDesktopClient && <div className="h-14 shrink-0" />}

        {/* Header / Brand */}
        <div
          className={cn(
            "flex items-center justify-between px-3 pb-2 shrink-0",
            !isDesktopClient && "border-b border-border py-3 px-4 gap-2.5",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <>
            <img
              src="/brand/logo-white-1.svg"
              alt="Claw-Pi"
              className="h-9 object-contain"
            />
            {isDesktopClient && hasUpdate && updateDismissed && (
              <button
                type="button"
                onClick={() => setUpdateDismissed(false)}
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-[var(--color-brand-primary)] text-white hover:opacity-85 transition-opacity"
              >
                {t("layout.update.badge")}
              </button>
            )}
            {/* collapse button removed — logo fills header */}
          </>
        </div>

        {/* Main nav + conversations */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {/* Nav items */}
          <div className="px-2 pt-3 pb-1">
            <Link
              to="/workspace/home"
              onClick={() => {
                track("workspace_home_click");
                track("workspace_sidebar_click", { target: "home" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isHomePage && "nav-item-active",
              )}
            >
              <Home size={16} className="shrink-0" />
              {t("layout.nav.home")}
            </Link>
            <button
              id="nav-runtime"
              type="button"
              onClick={handleOpenRuntime}
              className="nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap"
            >
              <Monitor size={16} className="shrink-0" />
              {t("layout.nav.runtime")}
              {isRuntimeFullyOnline && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--color-success)] shrink-0" />
              )}
              {!isRuntimeFullyOnline &&
                (showRuntimeBootGrace ||
                  runtimeStatus?.status === "starting") && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse shrink-0" />
                )}
            </button>
            <Link
              to="/workspace/models"
              onClick={() => {
                track("workspace_models_click");
                track("workspace_sidebar_click", { target: "models" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isModelsPage && "nav-item-active",
              )}
            >
              <Cpu size={16} className="shrink-0" />
              {t("layout.nav.models")}
            </Link>
            <Link
              to="/workspace/skills"
              onClick={() => {
                track("workspace_skills_click");
                track("workspace_sidebar_click", { target: "skills" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isSkillsPage && "nav-item-active",
              )}
            >
              <Sparkles size={16} className="shrink-0" />
              {t("layout.nav.skills")}
              {installedSkillsCount > 0 && (
                <span className="ml-auto text-[10px] text-text-tertiary font-normal">
                  {installedSkillsCount}
                </span>
              )}
            </Link>
            <Link
              id="nav-recharge"
              to="/workspace/recharge"
              onClick={() => {
                track("workspace_recharge_click");
                track("workspace_sidebar_click", { target: "recharge" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isRechargePage && "nav-item-active",
              )}
            >
              <Wallet size={16} className="shrink-0" />
              {t("layout.nav.recharge")}
            </Link>
          </div>

          {/* Conversations section */}
          <div className="px-2 pt-6">
            <div className="sidebar-section-label whitespace-nowrap">
              {t("layout.conversations")}
            </div>
            <div className="space-y-0.5">
              {sessions.map((s) => {
                const isActive = selectedSessionId === s.id;
                return (
                  <button
                    type="button"
                    key={s.id}
                    data-sidebar-session-row={s.id}
                    data-session-channel-type={s.channelType ?? "web"}
                    data-session-state={s.status || "idle"}
                    onClick={() => {
                      const channel = normalizeChannel(s.channelType);
                      track("workspace_channel_click", {
                        channel_type: s.channelType,
                      });
                      track("workspace_sidebar_click", {
                        target: "conversations",
                        ...(channel ? { channel } : {}),
                      });
                      navigate(`/workspace/sessions/${s.id}`);
                    }}
                    className={cn(
                      "group flex items-center gap-2.5 w-full rounded-[10px] transition-colors cursor-pointer px-3 py-2 text-left",
                      isActive && "nav-item-active",
                    )}
                  >
                    <SidebarPlatformIcon platform={s.channelType ?? "web"} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={cn(
                            "text-[12px] truncate whitespace-nowrap font-medium",
                            !isActive && "text-text-primary",
                          )}
                        >
                          {s.title}
                        </div>
                        {s.status === "active" && (
                          <span className="shrink-0 rounded-full bg-[var(--color-success-subtle)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-success)]">
                            {t("layout.sessionLive")}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted truncate whitespace-nowrap">
                        <span>
                          {getPlatformLabel(s.channelType ?? "web", t)}
                        </span>
                        <span className="text-border">·</span>
                        <span>{formatTime(s.lastTime, t)}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {s.status === "active" && (
                        <div className="w-2 h-2 rounded-full bg-[var(--color-success)] shrink-0" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom action row */}
        <div
          className="px-3 pb-1.5 flex items-center justify-between gap-1 shrink-0"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="flex items-center gap-1">
            <div className="relative" ref={helpRef}>
              {showHelpMenu && (
                <div className="absolute z-20 bottom-full left-0 mb-2 w-44">
                  <div className="rounded-xl border bg-surface-1 border-border shadow-xl shadow-black/10 overflow-hidden">
                    <div className="p-1.5">
                      <a
                        href="https://claw-pi.cn/"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() =>
                          track("workspace_docs_click", { type: "doc" })
                        }
                        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-black/5 transition-all"
                      >
                        <BookOpen size={14} />
                        {t("layout.help.docs")}
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          if (!showQrPopover) {
                            track("workspace_docs_click", { type: "contact" });
                          }
                          setShowQrPopover((v) => !v);
                        }}
                        className={cn(
                          "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium transition-all cursor-pointer",
                          showQrPopover
                            ? "text-text-primary bg-black/5"
                            : "text-text-secondary hover:text-text-primary hover:bg-black/5",
                        )}
                      >
                        <QrCode size={14} />
                        {t("layout.help.wechat")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {showHelpMenu && showQrPopover && (
                <div className="absolute z-20 bottom-full left-full ml-2 mb-2">
                  <div className="rounded-xl border border-border shadow-xl shadow-black/10 overflow-hidden bg-white">
                    <img
                      src="/wechat-qr.png"
                      alt={t("layout.help.wechatHint")}
                      className="block w-44 h-auto"
                    />
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!showHelpMenu) {
                    track("workspace_help_menu_open");
                  }
                  setShowHelpMenu(!showHelpMenu);
                  setShowLangMenu(false);
                }}
                className={cn(
                  "w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer",
                  showHelpMenu
                    ? "text-text-primary bg-black/5"
                    : "text-text-secondary hover:text-text-primary hover:bg-black/5",
                )}
                title={t("layout.help.title")}
              >
                <CircleHelp size={16} />
              </button>
            </div>
          </div>

          <div className="relative" ref={langRef}>
            {showLangMenu && (
              <div className="absolute z-[60] bottom-full right-0 mb-2 w-28">
                <div className="rounded-xl border bg-surface-1 border-border shadow-xl shadow-black/10 overflow-hidden p-1.5">
                  {(
                    [
                      { value: "en", label: "English" },
                      { value: "zh", label: "中文" },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setLocale(option.value as Locale);
                        setShowLangMenu(false);
                      }}
                      className={cn(
                        "flex items-center justify-between gap-2 w-full px-3 py-2 rounded-lg text-[12px] font-medium transition-all",
                        locale === option.value
                          ? "bg-black/5 text-text-primary"
                          : "text-text-secondary hover:text-text-primary hover:bg-black/5",
                      )}
                    >
                      <span>{option.label}</span>
                      {locale === option.value && (
                        <span className="text-[10px] text-text-muted">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setShowLangMenu(!showLangMenu);
                setShowHelpMenu(false);
              }}
              className={cn(
                "h-7 inline-flex items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors cursor-pointer",
                showLangMenu
                  ? "text-text-primary bg-black/5"
                  : "text-text-secondary hover:text-text-primary hover:bg-black/5",
              )}
              title={t("layout.switchLanguage")}
            >
              <Globe size={14} />
              <span>{locale === "en" ? "EN" : "中文"}</span>
            </button>
          </div>
        </div>

        {/* Account */}
        <div className="relative shrink-0" ref={logoutRef}>
          {showLogoutConfirm && (
            <div className="absolute z-20 bottom-full left-1.5 right-1.5 mb-2">
              <div className="rounded-xl border bg-surface-1 border-border shadow-xl shadow-black/10 overflow-hidden">
                <div className="px-3.5 py-3 border-b border-border">
                  <div className="text-[12px] font-medium text-text-primary truncate whitespace-nowrap">
                    {userEmail}
                  </div>
                </div>
                <div className="p-1.5">
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-muted hover:text-red-500 hover:bg-red-500/5 transition-all cursor-pointer whitespace-nowrap"
                  >
                    <LogOut size={13} />
                    {t("layout.signOut")}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-border px-2 py-2">
            <button
              type="button"
              onClick={() => setShowLogoutConfirm(!showLogoutConfirm)}
              className="flex gap-2.5 items-center w-full px-2 py-2 rounded-lg transition-all hover:bg-surface-3 cursor-pointer"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              {userImage ? (
                <img
                  src={userImage}
                  alt={userName}
                  className="w-7 h-7 rounded-md object-cover ring-1 ring-accent/10 shrink-0"
                />
              ) : (
                <div className="flex justify-center items-center w-7 h-7 rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-[10px] font-bold text-accent ring-1 ring-accent/10 shrink-0">
                  {userInitial}
                </div>
              )}
              <div className="flex-1 min-w-0 text-left">
                <div className="text-[12px] text-text-primary truncate font-medium whitespace-nowrap">
                  {userName}
                </div>
                <div className="text-[10px] text-text-muted truncate whitespace-nowrap">
                  {userEmail}
                </div>
              </div>
              <ChevronUp
                size={12}
                className={cn(
                  "text-text-muted/50 shrink-0 transition-transform duration-150",
                  showLogoutConfirm ? "rotate-0" : "rotate-180",
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              setMobileDrawerOpen(false);
              setShowLogoutConfirm(false);
            }}
          />
          <div className="absolute inset-y-0 left-0 w-[84%] max-w-[320px] sidebar-vibrancy border-r border-border shadow-xl">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <img
                  src="/brand/logo-white-1.svg"
                  alt="Claw-Pi"
                  className="h-9 object-contain"
                />
                <button
                  type="button"
                  onClick={() => setMobileDrawerOpen(false)}
                  className="p-1.5 rounded-lg transition-colors text-text-muted hover:text-text-primary hover:bg-surface-3"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {/* Nav items */}
                <div className="px-3 pt-3 pb-1">
                  <Link
                    to="/workspace/home"
                    onClick={() => {
                      track("workspace_home_click");
                      track("workspace_sidebar_click", { target: "home" });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isHomePage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <Home size={14} />
                    {t("layout.nav.home")}
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      handleOpenRuntime();
                      setMobileDrawerOpen(false);
                    }}
                    className="flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2 text-text-muted hover:text-text-primary hover:bg-surface-3"
                  >
                    <Monitor size={14} />
                    {t("layout.nav.runtime")}
                    {isRuntimeFullyOnline && (
                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--color-success)] shrink-0" />
                    )}
                    {!isRuntimeFullyOnline &&
                      (showRuntimeBootGrace ||
                        runtimeStatus?.status === "starting") && (
                        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse shrink-0" />
                      )}
                  </button>
                  <Link
                    to="/workspace/models"
                    onClick={() => {
                      track("workspace_models_click");
                      track("workspace_sidebar_click", { target: "models" });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isModelsPage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <Cpu size={14} />
                    {t("layout.nav.models")}
                  </Link>
                  <Link
                    to="/workspace/skills"
                    onClick={() => {
                      track("workspace_skills_click");
                      track("workspace_sidebar_click", { target: "skills" });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isSkillsPage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles size={14} />
                      {t("layout.nav.skills")}
                    </span>
                  </Link>
                  <Link
                    to="/workspace/recharge"
                    onClick={() => {
                      track("workspace_recharge_click");
                      track("workspace_sidebar_click", { target: "recharge" });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isRechargePage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <Wallet size={14} />
                    {t("layout.nav.recharge")}
                  </Link>
                </div>

                {/* Conversations section */}
                <div className="px-3 pt-2 pb-3">
                  <div className="border-t border-border pt-2 mb-1.5" />
                  <div className="px-3 mb-1.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    {t("layout.conversations")}
                  </div>
                  <div className="space-y-0.5">
                    {sessions.map((s) => {
                      const isActive = selectedSessionId === s.id;
                      return (
                        <button
                          type="button"
                          key={s.id}
                          data-sidebar-session-row={s.id}
                          data-session-channel-type={s.channelType ?? "web"}
                          data-session-state={s.status || "idle"}
                          onClick={() => {
                            const channel = normalizeChannel(s.channelType);
                            track("workspace_channel_click", {
                              channel_type: s.channelType,
                            });
                            track("workspace_sidebar_click", {
                              target: "conversations",
                              ...(channel ? { channel } : {}),
                            });
                            setMobileDrawerOpen(false);
                            navigate(`/workspace/sessions/${s.id}`);
                          }}
                          className={cn(
                            "flex items-center gap-2.5 w-full rounded-[10px] transition-colors cursor-pointer px-2.5 py-2 text-left",
                            isActive
                              ? "bg-accent/10 text-accent"
                              : "text-text-secondary hover:text-text-primary hover:bg-surface-3",
                          )}
                        >
                          <SidebarPlatformIcon
                            platform={s.channelType ?? "web"}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="text-[13px] truncate font-medium">
                                {s.title}
                              </div>
                              {s.status === "active" && (
                                <span className="shrink-0 rounded-full bg-[var(--color-success-subtle)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-success)]">
                                  {t("layout.sessionLive")}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted truncate">
                              <span>
                                {getPlatformLabel(s.channelType ?? "web", t)}
                              </span>
                              <span className="text-border">·</span>
                              <span>{formatTime(s.lastTime, t)}</span>
                            </div>
                          </div>
                          {s.status === "active" ? (
                            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--color-success)]" />
                          ) : (
                            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-text-muted/30" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Language toggle (mobile) */}
              <div className="px-3 pb-1">
                <LanguageToggle collapsed={false} />
              </div>

              <div
                className="relative border-t border-border p-2"
                ref={logoutRef}
              >
                {showLogoutConfirm && (
                  <div className="absolute bottom-full left-2 right-2 mb-2 z-20">
                    <div className="rounded-xl border bg-surface-1 border-border shadow-xl shadow-black/10 overflow-hidden">
                      <div className="px-3.5 py-3 border-b border-border">
                        <div className="text-[12px] font-medium text-text-primary truncate">
                          {userEmail}
                        </div>
                      </div>
                      <div className="p-1.5">
                        <button
                          type="button"
                          onClick={handleLogout}
                          className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-muted hover:text-red-500 hover:bg-red-500/5 transition-all cursor-pointer"
                        >
                          <LogOut size={13} />
                          {t("layout.signOut")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowLogoutConfirm(!showLogoutConfirm)}
                  className="flex gap-2.5 items-center w-full px-2 py-2 rounded-lg transition-all hover:bg-surface-3 cursor-pointer"
                >
                  <div className="flex justify-center items-center w-7 h-7 rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-[10px] font-bold text-accent ring-1 ring-accent/10 shrink-0">
                    {userInitial}
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <div className="text-[12px] text-text-primary truncate font-medium">
                      {userEmail}
                    </div>
                  </div>
                  <ChevronUp
                    size={12}
                    className={cn(
                      "text-text-muted/50 shrink-0 transition-transform duration-150",
                      showLogoutConfirm ? "rotate-0" : "rotate-180",
                    )}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Resize handle */}
      {!collapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="relative z-10 hidden w-[3px] shrink-0 cursor-col-resize bg-surface-0 md:block"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div className="absolute inset-y-0 -left-[2px] -right-[2px]" />
        </div>
      )}

      {/* Main content — elevated surface with rounded left edge */}
      <div className="relative flex-1 min-w-0 overflow-hidden">
        {isMacDesktop && (
          <div
            className="absolute inset-y-0 left-0 w-4 pointer-events-none"
            style={{ background: desktopGlassTint }}
          />
        )}
        <div
          className={cn(
            "relative flex h-full min-w-0 flex-col overflow-hidden bg-surface-1 rounded-l-[12px]",
          )}
        >
          <div className="md:hidden sticky top-0 z-30 border-b border-border bg-surface-0/95 backdrop-blur px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(true)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                aria-label="Open menu"
              >
                <Menu size={16} />
              </button>
              <div className="min-w-0 flex-1 text-center leading-tight">
                <div className="text-[13px] font-semibold text-text-primary truncate">
                  {mobileTitle}
                </div>
                <div className="text-[10px] text-text-muted truncate mt-0.5">
                  {mobileSubtitle}
                </div>
              </div>
              <div className="w-9" />
            </div>
          </div>

          <main className="flex-1 overflow-y-auto min-h-0">
            {showEmptyState ? (
              <EmptyState onGoConfig={() => navigate("/workspace/settings")} />
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
