import * as amplitude from "@amplitude/unified";
import { Identify } from "@amplitude/unified";
import * as Sentry from "@sentry/electron/renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import ReactDOM from "react-dom/client";
import { Toaster, toast } from "sonner";
import type {
  AppInfo,
  DesktopChromeMode,
  DesktopRuntimeConfig,
  DesktopSurface,
  DiagnosticsInfo,
  RuntimeEvent,
  RuntimeLogEntry,
  RuntimeState,
  RuntimeUnitId,
  RuntimeUnitPhase,
  RuntimeUnitSnapshot,
  RuntimeUnitState,
} from "../shared/host";
import { getDesktopSentryBuildMetadata } from "../shared/sentry-build-metadata";
import { SurfaceFrame } from "./components/surface-frame";
import { UpdateBanner } from "./components/update-banner";
import { useAutoUpdate } from "./hooks/use-auto-update";
import {
  checkComponentUpdates,
  exportDiagnostics,
  getAppInfo,
  getDiagnosticsInfo,
  getRuntimeConfig,
  getRuntimeState,
  installComponent,
  notifySetupAnimationComplete,
  onDesktopCommand,
  onRuntimeEvent,
  reportStartupProbe,
  startAllUnits,
  showRuntimeLogFile,
  startUnit,
  stopUnit,
  triggerMainProcessCrash,
  triggerRendererProcessCrash,
} from "./lib/host-api";
import { CloudProfilePage } from "./pages/cloud-profile-page";
import "./runtime-page.css";

const amplitudeApiKey = import.meta.env.VITE_AMPLITUDE_API_KEY;
const rendererSentryDsn =
  typeof window === "undefined" ? null : window.clawpiHost.bootstrap.sentryDsn;

let rendererSentryInitialized = false;
let amplitudeTelemetryInitialized = false;
let rendererCommitReported = false;
const setupVideoUrl = "data:,";
const setupLoopVideoUrl = "data:,";

function sendRendererStartupProbe(
  stage: string,
  status: "ok" | "error",
  detail?: string | null,
): void {
  try {
    reportStartupProbe({
      source: "renderer",
      stage,
      status,
      detail: detail ?? null,
    });
  } catch (error) {
    console.error("[desktop] failed to report startup probe", error);
  }
}

sendRendererStartupProbe("renderer:module-start", "ok");

window.addEventListener("error", (event) => {
  const detail =
    event.error instanceof Error
      ? (event.error.stack ?? event.error.message)
      : event.message;
  sendRendererStartupProbe("renderer:window-error", "error", detail);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const detail =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  sendRendererStartupProbe("renderer:unhandled-rejection", "error", detail);
});

function initializeRendererSentry(dsn: string): void {
  if (rendererSentryInitialized) {
    return;
  }

  const sentryBuildMetadata = getDesktopSentryBuildMetadata(
    window.clawpiHost.bootstrap.buildInfo,
  );

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: sentryBuildMetadata.release,
    ...(sentryBuildMetadata.dist ? { dist: sentryBuildMetadata.dist } : {}),
  });

  Sentry.setContext("build", sentryBuildMetadata.buildContext);

  rendererSentryInitialized = true;
}

function initializeAmplitudeTelemetry(): void {
  if (amplitudeTelemetryInitialized || !amplitudeApiKey) {
    return;
  }

  amplitude.initAll(amplitudeApiKey, {
    analytics: { autocapture: true },
    sessionReplay: { sampleRate: 1 },
  });
  const env = new Identify();
  env.set("environment", import.meta.env.MODE);
  amplitude.identify(env);
  amplitudeTelemetryInitialized = true;
}

function maskSentryDsn(dsn: string | null | undefined): string {
  if (!dsn) {
    return "missing";
  }

  const match = dsn.match(/^(https?:\/\/)([^@]+)@(.+)$/);

  if (!match) {
    return "configured";
  }

  const [, protocol, publicKey, hostAndPath] = match;
  const visibleKey = publicKey.slice(-6);
  const maskedKey = `${"*".repeat(Math.max(publicKey.length - 6, 3))}${visibleKey}`;

  return `${protocol}${maskedKey}@${hostAndPath}`;
}

function formatBuildTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "(unknown)";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const timezoneOffsetMinutes = -date.getTimezoneOffset();
  const offsetSign = timezoneOffsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(
    Math.floor(Math.abs(timezoneOffsetMinutes) / 60),
  ).padStart(2, "0");
  const offsetMinutes = String(Math.abs(timezoneOffsetMinutes) % 60).padStart(
    2,
    "0",
  );

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

function formatBuildCommit(value: string | null | undefined): string {
  if (!value) {
    return "(unknown)";
  }

  return value.slice(0, 7);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function phaseTone(phase: RuntimeUnitPhase): string {
  switch (phase) {
    case "running":
      return "is-running";
    case "failed":
      return "is-failed";
    case "starting":
    case "stopping":
      return "is-busy";
    default:
      return "is-idle";
  }
}

function kindLabel(unit: RuntimeUnitState): string {
  return `${unit.kind} / ${unit.launchStrategy}`;
}

function formatLogLine(entry: RuntimeLogEntry): string {
  const actionLabel = entry.actionId ? ` [action=${entry.actionId}]` : "";
  return `#${entry.cursor} ${entry.ts} [${entry.stream}] [${entry.kind}] [reason=${entry.reasonCode}]${actionLabel} ${entry.message}`;
}

function logFilterLabel(filter: LogFilter): string {
  switch (filter) {
    case "errors":
      return "Errors";
    case "lifecycle":
      return "Lifecycle";
    default:
      return "All";
  }
}

type LogFilter = "all" | "errors" | "lifecycle";

function mergeUnitSnapshot(
  current: RuntimeUnitState,
  snapshot: RuntimeUnitSnapshot,
): RuntimeUnitState {
  return {
    ...current,
    ...snapshot,
  };
}

function applyRuntimeEvent(
  current: RuntimeState,
  event: RuntimeEvent,
): RuntimeState {
  switch (event.type) {
    case "runtime:unit-state": {
      const existingIndex = current.units.findIndex(
        (unit) => unit.id === event.unit.id,
      );

      if (existingIndex === -1) {
        return current;
      }

      const nextUnits = [...current.units];
      const existingUnit = nextUnits[existingIndex];
      if (!existingUnit) {
        return current;
      }
      nextUnits[existingIndex] = mergeUnitSnapshot(existingUnit, event.unit);
      return {
        ...current,
        units: nextUnits,
      };
    }
    case "runtime:unit-log": {
      const existingIndex = current.units.findIndex(
        (unit) => unit.id === event.unitId,
      );

      if (existingIndex === -1) {
        return current;
      }

      const target = current.units[existingIndex];
      if (!target) {
        return current;
      }
      if (target.logTail.some((entry) => entry.id === event.entry.id)) {
        return current;
      }

      const nextUnits = [...current.units];
      nextUnits[existingIndex] = {
        ...target,
        logTail: [...target.logTail, event.entry].slice(-200),
      };

      return {
        ...current,
        units: nextUnits,
      };
    }
  }
}

function SurfaceButton({
  active,
  disabled,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? "desktop-nav-item is-active" : "desktop-nav-item"}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <small>{meta}</small>
    </button>
  );
}

function SummaryCard({
  label,
  value,
  className,
}: {
  label: string;
  value: string | number;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function getWebviewPreloadUrl(): string {
  return new URL(
    "../dist-electron/preload/webview-preload.js",
    document.location.href,
  ).href;
}

// SurfaceFrame is imported from the shared component — see components/surface-frame.tsx

function RuntimeUnitCard({
  unit,
  onStart,
  onStop,
  busy,
}: {
  unit: RuntimeUnitState;
  onStart: (id: RuntimeUnitId) => Promise<void>;
  onStop: (id: RuntimeUnitId) => Promise<void>;
  busy: boolean;
}) {
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const isManaged =
    unit.launchStrategy === "managed" || unit.launchStrategy === "launchd";
  const canStart =
    isManaged &&
    (unit.phase === "idle" ||
      unit.phase === "stopped" ||
      unit.phase === "failed");
  const canStop =
    isManaged && (unit.phase === "running" || unit.phase === "starting");

  async function handleCopyLogs(): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        filteredLogTail.map((entry) => formatLogLine(entry)).join("\n"),
      );
      toast.success(`Copied recent logs for ${unit.label}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to copy runtime logs.",
      );
    }
  }

  async function handleExportLogs(): Promise<void> {
    try {
      const ok = await showRuntimeLogFile(unit.id);

      if (!ok) {
        toast.error(`No log file available for ${unit.label}.`);
        return;
      }

      toast.success(`Revealed log file for ${unit.label}.`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to open runtime log file.",
      );
    }
  }

  const filteredLogTail = useMemo(() => {
    switch (logFilter) {
      case "errors":
        return unit.logTail.filter((entry) => entry.stream === "stderr");
      case "lifecycle":
        return unit.logTail.filter((entry) => entry.kind === "lifecycle");
      default:
        return unit.logTail;
    }
  }, [logFilter, unit.logTail]);

  return (
    <article className="runtime-card">
      <div className="runtime-card-head">
        <div>
          <div className="runtime-label-row">
            <strong>{unit.label}</strong>
            <span className={`runtime-badge ${phaseTone(unit.phase)}`}>
              {unit.phase}
            </span>
          </div>
          <p className="runtime-kind">{kindLabel(unit)}</p>
          <p className="runtime-command">
            {unit.commandSummary ?? "embedded runtime unit"}
          </p>
        </div>
        <div className="runtime-actions">
          <button
            disabled={!canStart || busy}
            onClick={() => void onStart(unit.id)}
            type="button"
          >
            Start
          </button>
          <button
            disabled={!canStop || busy}
            onClick={() => void onStop(unit.id)}
            type="button"
          >
            Stop
          </button>
        </div>
      </div>

      <dl className="runtime-grid">
        <div>
          <dt>PID</dt>
          <dd>{unit.pid ?? "-"}</dd>
        </div>
        <div>
          <dt>Port</dt>
          <dd>{unit.port ?? "-"}</dd>
        </div>
        <div>
          <dt>Auto start</dt>
          <dd>{unit.autoStart ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{unit.exitCode ?? "-"}</dd>
        </div>
        <div>
          <dt>Last reason</dt>
          <dd>{unit.lastReasonCode ?? "-"}</dd>
        </div>
        <div>
          <dt>Restarts</dt>
          <dd>{unit.restartCount}</dd>
        </div>
        <div>
          <dt>Last probe</dt>
          <dd>{unit.lastProbeAt ?? "-"}</dd>
        </div>
      </dl>

      {unit.lastError ? (
        <p className="runtime-error">{unit.lastError}</p>
      ) : null}

      {unit.binaryPath ? (
        <div className="runtime-binary-path">
          <div className="runtime-logs-head">
            <strong>OPENCLAW_BIN</strong>
          </div>
          <code>{unit.binaryPath}</code>
        </div>
      ) : null}

      <div className="runtime-logs">
        <div className="runtime-logs-head">
          <strong>Tail 200 logs</strong>
          <div className="runtime-logs-actions">
            <span>{filteredLogTail.length} lines</span>
            {(["all", "errors", "lifecycle"] as const).map((filter) => (
              <button
                aria-pressed={logFilter === filter}
                key={filter}
                onClick={() => setLogFilter(filter)}
                type="button"
              >
                {logFilterLabel(filter)}
              </button>
            ))}
            <button onClick={() => void handleCopyLogs()} type="button">
              Copy
            </button>
            <button onClick={() => void handleExportLogs()} type="button">
              Reveal
            </button>
          </div>
        </div>
        <pre className="runtime-log-tail">
          {filteredLogTail.length > 0
            ? filteredLogTail.map((entry) => formatLogLine(entry)).join("\n")
            : "No logs yet."}
        </pre>
      </div>
    </article>
  );
}

type ComponentUpdateInfo = {
  id: string;
  currentVersion: string | null;
  newVersion: string;
  size: number;
};

function RuntimePage() {
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeUnitId, setActiveUnitId] = useState<RuntimeUnitId | null>(null);
  const [componentUpdates, setComponentUpdates] = useState<
    ComponentUpdateInfo[] | null
  >(null);
  const [componentBusy, setComponentBusy] = useState(false);
  const [componentMessage, setComponentMessage] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const nextState = await getRuntimeState();
      setRuntimeState(nextState);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to load runtime state.",
      );
    }
  }, []);

  useEffect(() => {
    void loadState();
    const unsubscribe = onRuntimeEvent((event) => {
      setRuntimeState((current) => {
        if (!current) {
          return current;
        }

        return applyRuntimeEvent(current, event);
      });
      setErrorMessage(null);
    });

    const timer = window.setInterval(() => {
      void loadState();
    }, 15000);

    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [loadState]);

  const summary = useMemo(() => {
    const units = runtimeState?.units ?? [];
    return {
      running: units.filter((unit) => unit.phase === "running").length,
      failed: units.filter((unit) => unit.phase === "failed").length,
      managed: units.filter(
        (unit) =>
          unit.launchStrategy === "managed" ||
          unit.launchStrategy === "launchd",
      ).length,
    };
  }, [runtimeState]);

  const units = runtimeState?.units ?? [];

  useEffect(() => {
    if (units.length === 0) {
      setActiveUnitId(null);
      return;
    }

    if (!activeUnitId || !units.some((unit) => unit.id === activeUnitId)) {
      setActiveUnitId(units[0]?.id ?? null);
    }
  }, [activeUnitId, units]);

  const activeUnit =
    units.find((unit) => unit.id === activeUnitId) ?? units[0] ?? null;

  async function runAction(id: string, action: () => Promise<RuntimeState>) {
    setBusyId(id);
    try {
      const nextState = await action();
      setRuntimeState(nextState);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Runtime action failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="runtime-page">
      <header className="runtime-header">
        <div>
          <span className="runtime-eyebrow">Claw-Pi Startup</span>
          <h1>Claw-Pi 启动修复中心</h1>
          <p>
            正在检查本地工作台、控制器和 OpenClaw 运行状态。若启动异常，可在这里查看状态并重新启动组件。
          </p>
        </div>
      </header>

      <section className="runtime-summary">
        <SummaryCard
          label="Started at"
          value={runtimeState?.startedAt ?? "-"}
        />
        <SummaryCard label="Running" value={summary.running} />
        <SummaryCard label="Managed" value={summary.managed} />
        <SummaryCard label="Failed" value={summary.failed} />
      </section>

      <section className="component-update-section">
        <div className="component-update-head">
          <strong>Component Updates</strong>
          <button
            disabled={componentBusy}
            onClick={() => {
              setComponentBusy(true);
              setComponentMessage(null);
              void checkComponentUpdates()
                .then((result) => {
                  setComponentUpdates(result.updates);
                  setComponentMessage(
                    result.updates.length === 0
                      ? "All components are up to date."
                      : `${result.updates.length} update(s) available.`,
                  );
                })
                .catch((error) => {
                  setComponentMessage(
                    error instanceof Error
                      ? error.message
                      : "Failed to check component updates.",
                  );
                })
                .finally(() => setComponentBusy(false));
            }}
            type="button"
          >
            {componentBusy ? "Checking..." : "Check"}
          </button>
        </div>
        {componentMessage ? (
          <p className="component-update-message">{componentMessage}</p>
        ) : null}
        {componentUpdates && componentUpdates.length > 0 ? (
          <ul className="component-update-list">
            {componentUpdates.map((u) => (
              <li key={u.id}>
                <span>
                  {u.id}: {u.currentVersion ?? "none"} → {u.newVersion} (
                  {u.size} bytes)
                </span>
                <button
                  disabled={componentBusy}
                  onClick={() => {
                    setComponentBusy(true);
                    void installComponent(u.id)
                      .then((result) => {
                        setComponentMessage(
                          result.ok
                            ? `Installed ${u.id} successfully.`
                            : `Failed to install ${u.id}.`,
                        );
                        if (result.ok) {
                          setComponentUpdates(
                            (prev) =>
                              prev?.filter((item) => item.id !== u.id) ?? null,
                          );
                        }
                      })
                      .catch((error) => {
                        setComponentMessage(
                          error instanceof Error
                            ? error.message
                            : `Install failed for ${u.id}.`,
                        );
                      })
                      .finally(() => setComponentBusy(false));
                  }}
                  type="button"
                >
                  Install
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <p className="runtime-note">
        Control plane currently renders unit metadata plus in-memory tail 200
        logs from the local orchestrator.
      </p>

      {errorMessage ? (
        <p className="runtime-error-banner">{errorMessage}</p>
      ) : null}

      <section className="runtime-pane-layout">
        <aside className="runtime-sidebar" aria-label="Runtime units">
          {units.map((unit) => (
            <button
              aria-selected={activeUnit?.id === unit.id}
              className={
                activeUnit?.id === unit.id
                  ? "runtime-side-tab is-active"
                  : "runtime-side-tab"
              }
              key={unit.id}
              onClick={() => setActiveUnitId(unit.id)}
              role="tab"
              type="button"
            >
              <span className="runtime-side-tab-label">{unit.label}</span>
              <span className={`runtime-badge ${phaseTone(unit.phase)}`}>
                {unit.phase}
              </span>
            </button>
          ))}
        </aside>

        <div className="runtime-detail-pane">
          {activeUnit ? (
            <RuntimeUnitCard
              busy={busyId !== null}
              onStart={(id) => runAction(`start:${id}`, () => startUnit(id))}
              onStop={(id) => runAction(`stop:${id}`, () => stopUnit(id))}
              unit={activeUnit}
            />
          ) : (
            <section className="runtime-empty-state">
              No runtime units available.
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

function EmbeddedControlPlane() {
  return (
    <>
      <RuntimePage />
      <Toaster position="top-right" />
    </>
  );
}

type DiagnosticsActionId =
  | "renderer-exception"
  | "renderer-crash"
  | "main-crash";

function DiagnosticsActionCard({
  description,
  disabled,
  label,
  onClick,
}: {
  description: string;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <article className="diagnostics-action-card">
      <div>
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <button disabled={disabled} onClick={onClick} type="button">
        Trigger
      </button>
    </article>
  );
}

function DiagnosticsPage({
  runtimeConfig,
}: {
  runtimeConfig: DesktopRuntimeConfig | null;
}) {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [diagnosticsInfo, setDiagnosticsInfo] =
    useState<DiagnosticsInfo | null>(null);
  const [busyAction, setBusyAction] = useState<DiagnosticsActionId | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string>(
    "Ready for diagnostics.",
  );

  useEffect(() => {
    void Promise.all([getAppInfo(), getDiagnosticsInfo()])
      .then(([nextAppInfo, nextDiagnosticsInfo]) => {
        setAppInfo(nextAppInfo);
        setDiagnosticsInfo(nextDiagnosticsInfo);
        setErrorMessage(null);
      })
      .catch((error) => {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to load diagnostics metadata.",
        );
      });
  }, []);

  const runAction = useCallback(
    async (actionId: DiagnosticsActionId, action: () => Promise<void>) => {
      setBusyAction(actionId);
      setErrorMessage(null);

      try {
        await action();
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Diagnostics action failed.",
        );
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const triggerRendererException = useCallback(() => {
    const title = "desktop.renderer.exception";
    setLastAction(
      `Renderer exception scheduled at ${new Date().toLocaleTimeString()}.`,
    );

    window.setTimeout(() => {
      throw new Error(title);
    }, 0);
  }, []);

  const triggerRendererCrash = useCallback(() => {
    setLastAction(
      `Renderer crash requested at ${new Date().toLocaleTimeString()}.`,
    );

    void runAction("renderer-crash", async () => {
      await triggerRendererProcessCrash();
    });
  }, [runAction]);

  const triggerMainCrash = useCallback(() => {
    setLastAction(
      `Main crash requested at ${new Date().toLocaleTimeString()}.`,
    );

    void runAction("main-crash", async () => {
      await triggerMainProcessCrash();
    });
  }, [runAction]);

  return (
    <div className="runtime-page diagnostics-page">
      <header className="runtime-header diagnostics-header">
        <div>
          <span className="runtime-eyebrow">Crash Diagnostics</span>
          <h1>Exercise the Electron failure paths on demand</h1>
          <p>
            Use one page to validate renderer exceptions, renderer process
            exits, and main process crashes through the local desktop
            observability stack.
          </p>
        </div>
      </header>

      <section className="runtime-summary diagnostics-summary">
        <SummaryCard
          label="App"
          value={appInfo ? `${appInfo.appName} ${appInfo.appVersion}` : "-"}
        />
        <SummaryCard label="Platform" value={appInfo?.platform ?? "-"} />
        <SummaryCard
          label="Mode"
          value={appInfo ? (appInfo.isDev ? "development" : "packaged") : "-"}
        />
        <SummaryCard
          label="Native crashes"
          value={
            diagnosticsInfo
              ? diagnosticsInfo.nativeCrashPipeline === "sentry"
                ? "sentry"
                : "local-only"
              : "-"
          }
        />
        <SummaryCard
          label="Claw-Pi 数据目录"
          className="diagnostics-summary-wide"
          value={runtimeConfig?.paths.nexuHome ?? "-"}
        />
        <SummaryCard
          label="Crash dumps"
          className="diagnostics-summary-wide"
          value={diagnosticsInfo?.crashDumpsPath ?? "-"}
        />
        <SummaryCard
          label="Sentry DSN"
          className="diagnostics-summary-wide"
          value={
            diagnosticsInfo ? maskSentryDsn(diagnosticsInfo.sentryDsn) : "-"
          }
        />
      </section>

      <p className="runtime-note diagnostics-note">
        The renderer exception path keeps the process alive and is meant for
        JavaScript error capture. The renderer crash and main crash paths
        terminate a process and are meant for native crash capture.
      </p>

      {errorMessage ? (
        <p className="runtime-error-banner">{errorMessage}</p>
      ) : null}

      <section className="diagnostics-grid">
        <DiagnosticsActionCard
          description="Throws an unhandled renderer Error named desktop.renderer.exception. Use this to validate JavaScript exception capture without killing the app."
          disabled={busyAction !== null}
          label="Test Renderer Exception"
          onClick={triggerRendererException}
        />
        <DiagnosticsActionCard
          description="Asks the main process to forcefully crash the current renderer process with the title desktop.renderer.crash. Use this to validate renderer crash handling and crash dump creation."
          disabled={busyAction !== null}
          label="Test Renderer Crash"
          onClick={triggerRendererCrash}
        />
        <DiagnosticsActionCard
          description="Invokes a deliberate main process crash with the title desktop.main.crash. Use this to validate the native crash pipeline for the Electron host itself."
          disabled={busyAction !== null}
          label="Test Main Crash"
          onClick={triggerMainCrash}
        />
      </section>

      <section className="diagnostics-status-card">
        <div>
          <span className="runtime-eyebrow">Last action</span>
          <h2>{lastAction}</h2>
          <p>
            Renderer process type: {diagnosticsInfo?.processType ?? "unknown"}.
            JavaScript exceptions should stay visible in the renderer and in
            Sentry when configured. Process crashes should leave Crashpad dumps
            and, with Sentry enabled, upload native crash events.
          </p>
        </div>
      </section>
    </div>
  );
}

type DesktopReadyPayload = {
  ready?: boolean;
  desktopReady?: boolean;
  webReady?: boolean;
  openclawReady?: boolean;
  agentReady?: boolean;
  channelsReady?: boolean;
  blockers?: Array<{
    scope: "desktop" | "web" | "openclaw" | "agent" | "channels";
    code: string;
    message: string;
  }>;
  runtime?: {
    ok?: boolean;
    status?: number | null;
    skipped?: boolean;
  };
  status?: "active" | "starting" | "degraded" | "unhealthy";
  gatewayConnected?: boolean;
};

const WEB_SURFACE_INACTIVE_UNMOUNT_MS = 120_000;

type ReadyFetchState = {
  status: "idle" | "reachable" | "unreachable";
  message: string | null;
};

type StartupAction = "restart" | "diagnostics";

type StartupStatusSummary = {
  tone: "waiting" | "warning" | "error";
  title: string;
  description: string;
  details: string[];
};

const STARTUP_UNIT_ORDER: RuntimeUnitId[] = [
  "web",
  "controller",
  "openclaw",
  "control-plane",
];

function runtimeUnitUserLabel(id: RuntimeUnitId): string {
  switch (id) {
    case "web":
      return "龙虾工作台界面";
    case "controller":
      return "本地控制服务";
    case "openclaw":
      return "OpenClaw 执行服务";
    case "control-plane":
      return "启动状态服务";
  }
}

function runtimePhaseLabel(phase: RuntimeUnitPhase): string {
  switch (phase) {
    case "running":
      return "已启动";
    case "starting":
      return "启动中";
    case "failed":
      return "异常";
    case "stopped":
      return "已停止";
    case "stopping":
      return "停止中";
    case "idle":
      return "等待启动";
  }
}

function blockerUserMessage(blocker: NonNullable<DesktopReadyPayload["blockers"]>[number]): string {
  switch (blocker.code) {
    case "openclaw_ws_disconnected":
    case "gateway_probe_disabled_no_ws":
      return "OpenClaw 网关正在连接";
    case "openclaw_health_unreachable":
      return "OpenClaw 执行服务还未响应";
    case "model_not_ready":
      return "默认模型正在同步";
    default:
      if (blocker.code.startsWith("openclaw_health_http_")) {
        return "OpenClaw 健康检查暂未通过";
      }
      return blocker.scope === "channels"
        ? "外部渠道正在连接"
        : "本地组件正在准备";
  }
}

function summarizeStartupUnits(runtimeState: RuntimeState | null): string[] {
  if (!runtimeState) {
    return ["正在读取本地组件状态"];
  }

  return STARTUP_UNIT_ORDER.map((id) => {
    const unit = runtimeState.units.find((candidate) => candidate.id === id);
    if (!unit) {
      return `${runtimeUnitUserLabel(id)}：等待状态`;
    }
    return `${runtimeUnitUserLabel(id)}：${runtimePhaseLabel(unit.phase)}`;
  });
}

function getPrimaryStartupUnit(runtimeState: RuntimeState | null) {
  const units = runtimeState?.units ?? [];
  const importantUnits = STARTUP_UNIT_ORDER.map((id) =>
    units.find((unit) => unit.id === id),
  ).filter((unit): unit is RuntimeUnitState => Boolean(unit));

  return (
    importantUnits.find((unit) => unit.phase === "failed") ??
    importantUnits.find((unit) => unit.phase === "starting") ??
    importantUnits.find((unit) => unit.phase !== "running") ??
    null
  );
}

function buildStartupStatus(input: {
  runtimeConfig: DesktopRuntimeConfig | null;
  runtimeState: RuntimeState | null;
  readyPayload: DesktopReadyPayload | null;
  readyFetch: ReadyFetchState;
  controllerReady: boolean;
}): StartupStatusSummary {
  const primaryUnit = getPrimaryStartupUnit(input.runtimeState);
  const failedUnit =
    primaryUnit?.phase === "failed" ? primaryUnit : null;
  const details = summarizeStartupUnits(input.runtimeState);

  if (failedUnit) {
    return {
      tone: "error",
      title: `${runtimeUnitUserLabel(failedUnit.id)}启动异常`,
      description:
        "可以先重试启动；如果仍然停在这里，请导出诊断包发给客服排查。",
      details,
    };
  }

  if (!input.runtimeConfig) {
    return {
      tone: "waiting",
      title: "正在启动龙虾工作台",
      description: primaryUnit
        ? `正在准备${runtimeUnitUserLabel(primaryUnit.id)}。`
        : "正在准备本地运行组件，请稍候。",
      details,
    };
  }

  if (input.readyFetch.status === "unreachable") {
    return {
      tone: "warning",
      title: "正在连接本地工作台服务",
      description:
        input.readyFetch.message ??
        "本地服务还没有响应，系统会继续自动等待。",
      details,
    };
  }

  const blockers = input.readyPayload?.blockers ?? [];
  if (!input.controllerReady && blockers.length > 0) {
    return {
      tone: "warning",
      title: blockerUserMessage(blockers[0]),
      description: "本地组件正在继续启动，工作台就绪后会自动打开。",
      details: blockers.slice(0, 3).map(blockerUserMessage),
    };
  }

  return {
    tone: "waiting",
    title: "正在打开龙虾工作台",
    description: "工作台页面正在加载，完成后会自动进入主界面。",
    details,
  };
}

function isDesktopApiReady(payload: DesktopReadyPayload): boolean {
  return Boolean(payload.ready || payload.desktopReady || payload.webReady);
}

function DesktopStartupStatusPanel({
  diagnosticsLabel = "导出诊断包",
  status,
  busyAction,
  retryLabel = "重试启动",
  onExportDiagnostics,
  onRetryStartup,
}: {
  diagnosticsLabel?: string;
  status: StartupStatusSummary;
  busyAction: StartupAction | null;
  retryLabel?: string;
  onExportDiagnostics: () => Promise<void>;
  onRetryStartup: () => Promise<void>;
}) {
  return (
    <div className={`startup-status-panel is-${status.tone}`}>
      <div className="startup-status-mark">Claw-Pi</div>
      <div>
        <span className="startup-status-eyebrow">龙虾工作台</span>
        <h2>{status.title}</h2>
        <p>{status.description}</p>
      </div>

      {status.details.length > 0 ? (
        <ul className="startup-status-list">
          {status.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}

      <div className="startup-status-actions">
        <button
          disabled={busyAction !== null}
          onClick={() => void onRetryStartup()}
          type="button"
        >
          {busyAction === "restart" ? "正在重试" : retryLabel}
        </button>
        <button
          disabled={busyAction !== null}
          onClick={() => void onExportDiagnostics()}
          type="button"
        >
          {busyAction === "diagnostics" ? "正在导出" : diagnosticsLabel}
        </button>
      </div>
    </div>
  );
}

function DesktopWebviewCrashPanel({
  exitCode,
  onExportDiagnostics,
  onReload,
  reason,
}: {
  exitCode: number | null;
  onExportDiagnostics: () => Promise<void>;
  onReload: () => void;
  reason: string;
}) {
  const status: StartupStatusSummary = {
    tone: "error",
    title: "工作台页面异常退出",
    description: "可以先重新加载页面；如果反复出现，请导出诊断包发给客服排查。",
    details: [
      `页面进程：${reason || "异常退出"}`,
      exitCode === null ? "退出码：无" : `退出码：${exitCode}`,
    ],
  };

  return (
    <div className="startup-status-overlay">
      <DesktopStartupStatusPanel
        busyAction={null}
        diagnosticsLabel="导出诊断包"
        onExportDiagnostics={onExportDiagnostics}
        onRetryStartup={async () => onReload()}
        retryLabel="重新加载"
        status={status}
      />
    </div>
  );
}

function DesktopShell() {
  const isPackaged = window.clawpiHost.bootstrap.isPackaged;
  const [activeSurface, setActiveSurface] = useState<DesktopSurface>("web");
  const [chromeMode, setChromeMode] = useState<DesktopChromeMode>(
    isPackaged ? "immersive" : "full",
  );
  const webSurfaceVersion = 0;
  const [runtimeConfig, setRuntimeConfig] =
    useState<DesktopRuntimeConfig | null>(null);
  const [startupRuntimeState, setStartupRuntimeState] =
    useState<RuntimeState | null>(null);
  const [readyPayload, setReadyPayload] = useState<DesktopReadyPayload | null>(
    null,
  );
  const [readyFetch, setReadyFetch] = useState<ReadyFetchState>({
    status: "idle",
    message: null,
  });
  const [startupBusyAction, setStartupBusyAction] =
    useState<StartupAction | null>(null);
  const [controllerReady, setControllerReady] = useState(false);
  const [openclawReady, setOpenclawReady] = useState(false);
  const update = useAutoUpdate();

  // Setup animation phases:
  // "playing" → main video (23s) plays once
  // "looping" → short loop video repeats until cold-start is ready
  // "fading" → overlay fades out (0.6s CSS transition)
  // "done" → overlay removed from DOM
  const [setupPhase, setSetupPhase] = useState<
    "playing" | "looping" | "fading" | "done"
  >("done");

  // When animation finishes, notify main process to restore vibrancy
  useEffect(() => {
    if (
      setupPhase === "done" &&
      window.clawpiHost.bootstrap.needsSetupAnimation
    ) {
      void notifySetupAnimationComplete();
    }
  }, [setupPhase]);

  useEffect(() => {
    void getRuntimeConfig()
      .then((config) => {
        setRuntimeConfig(config);
        // Cold-start is done — if we're still in the looping phase, fade out.
        // If main video hasn't finished yet, it will transition to fade on its
        // own via onEnded (the main video is the minimum guaranteed animation).
        setSetupPhase((prev) => (prev === "looping" ? "fading" : prev));
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    return onDesktopCommand((command) => {
      if (command.type === "desktop:check-for-updates") {
        void update.check();
        return;
      }
      if (command.type === "setup:complete") {
        return;
      }

      setActiveSurface(command.surface);
      setChromeMode(command.chromeMode);
    });
  }, [update]);

  const loadStartupRuntimeState = useCallback(async () => {
    try {
      const nextState = await getRuntimeState();
      setStartupRuntimeState(nextState);
    } catch {
      // The branded startup panel can still show a generic waiting state.
    }
  }, []);

  useEffect(() => {
    if (controllerReady) return;

    void loadStartupRuntimeState();
    const unsubscribe = onRuntimeEvent((event) => {
      setStartupRuntimeState((current) =>
        current ? applyRuntimeEvent(current, event) : current,
      );
    });
    const timer = window.setInterval(() => {
      void loadStartupRuntimeState();
    }, 4000);

    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [controllerReady, loadStartupRuntimeState]);

  // Poll the controller ready endpoint through the web sidecar proxy before mounting the webview.
  // Note: getRuntimeConfig() IPC handler waits for cold-start to complete, so
  // runtimeConfig always has the final ports (including any fallback).
  useEffect(() => {
    if (!runtimeConfig) return;

    let cancelled = false;
    const readyUrl = new URL(
      "/api/internal/desktop/ready",
      runtimeConfig.urls.web,
    ).toString();

    async function poll() {
      while (!cancelled) {
        try {
          const res = await fetch(readyUrl, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const data = (await res.json()) as DesktopReadyPayload;
            if (!cancelled) {
              setReadyPayload(data);
              setReadyFetch({ status: "reachable", message: null });
            }

            if (typeof data.openclawReady === "boolean" && !cancelled) {
              setOpenclawReady(data.openclawReady);
            }

            if (!cancelled && isDesktopApiReady(data)) {
              setControllerReady(true);
            }
          } else if (!cancelled) {
            setReadyFetch({
              status: "unreachable",
              message: `本地服务返回 HTTP ${res.status}，正在继续等待。`,
            });
          }
        } catch {
          if (!cancelled) {
            setReadyFetch({
              status: "unreachable",
              message: "本地服务暂未响应，正在继续等待。",
            });
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [runtimeConfig]);

  const startupStatus = useMemo(
    () =>
      buildStartupStatus({
        controllerReady,
        readyFetch,
        readyPayload,
        runtimeConfig,
        runtimeState: startupRuntimeState,
      }),
    [
      controllerReady,
      readyFetch,
      readyPayload,
      runtimeConfig,
      startupRuntimeState,
    ],
  );

  const handleRetryStartup = useCallback(async () => {
    setStartupBusyAction("restart");
    try {
      const nextState = await startAllUnits();
      setStartupRuntimeState(nextState);
      setControllerReady(false);
      setReadyFetch({ status: "idle", message: null });
      toast.success("已重新启动本地组件。");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "重新启动本地组件失败。",
      );
    } finally {
      setStartupBusyAction(null);
    }
  }, []);

  const handleExportStartupDiagnostics = useCallback(async () => {
    setStartupBusyAction("diagnostics");
    try {
      const result = await exportDiagnostics("diagnostics-page");
      if (result.status === "success") {
        toast.success("诊断包已导出。");
      } else if (result.status === "cancelled") {
        toast.info("已取消导出诊断包。");
      } else {
        toast.error(result.errorMessage ?? "导出诊断包失败。");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "导出诊断包失败。",
      );
    } finally {
      setStartupBusyAction(null);
    }
  }, []);

  const desktopWebUrl =
    runtimeConfig && controllerReady
      ? new URL("/workspace", runtimeConfig.urls.web).toString()
      : null;
  const desktopOpenClawUrl = runtimeConfig && openclawReady
    ? new URL(
        `/chat#token=${encodeURIComponent(runtimeConfig.tokens.gateway)}`,
        runtimeConfig.urls.openclawBase,
      ).toString()
    : null;
  return (
    <div
      className={
        chromeMode === "immersive"
          ? "desktop-shell is-immersive"
          : "desktop-shell"
      }
    >
      <div className="window-drag-bar" />
      <aside className="desktop-sidebar">
        <div className="desktop-sidebar-brand">
          <span className="desktop-shell-eyebrow">Claw-Pi Desktop</span>
          <h1>启动修复中心</h1>
          <p>
            用于检查龙虾工作台启动状态、组件健康和本地 OpenClaw 连接。
          </p>
        </div>

        <nav className="desktop-nav" aria-label="Desktop surfaces">
          <SurfaceButton
            active={activeSurface === "control"}
            label="启动状态"
            meta="查看组件状态并处理启动异常"
            onClick={() => setActiveSurface("control")}
          />
          <SurfaceButton
            active={activeSurface === "cloud-profile"}
            label="云端账号"
            meta="切换云端服务并重置登录状态"
            onClick={() => setActiveSurface("cloud-profile")}
          />
          <SurfaceButton
            active={activeSurface === "web"}
            disabled={!desktopWebUrl}
            label="龙虾工作台"
            meta="打开主工作台界面"
            onClick={() => setActiveSurface("web")}
          />
          <SurfaceButton
            active={activeSurface === "openclaw"}
            disabled={!desktopOpenClawUrl}
            label="OpenClaw"
            meta="打开 OpenClaw 原生调试页"
            onClick={() => setActiveSurface("openclaw")}
          />
          <SurfaceButton
            active={activeSurface === "diagnostics"}
            label="诊断"
            meta="导出日志并检查异常"
            onClick={() => setActiveSurface("diagnostics")}
          />
        </nav>

        {runtimeConfig ? (
          <div className="desktop-sidebar-config">
            <span className="desktop-shell-eyebrow">版本信息</span>
            <dl className="desktop-config-list">
              <div>
                <dt>Source</dt>
                <dd>{runtimeConfig.buildInfo.source}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{runtimeConfig.buildInfo.version}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{runtimeConfig.buildInfo.branch ?? "(unknown)"}</dd>
              </div>
              <div>
                <dt>Commit</dt>
                <dd title={runtimeConfig.buildInfo.commit ?? undefined}>
                  {formatBuildCommit(runtimeConfig.buildInfo.commit)}
                </dd>
              </div>
              <div>
                <dt>Built At</dt>
                <dd>{formatBuildTimestamp(runtimeConfig.buildInfo.builtAt)}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </aside>

      <main className="desktop-shell-stage">
        <div
          className={
            activeSurface === "control"
              ? "desktop-surface-slot is-active"
              : "desktop-surface-slot"
          }
        >
          <EmbeddedControlPlane />
        </div>
        <div
          className={
            activeSurface === "cloud-profile"
              ? "desktop-surface-slot is-active"
              : "desktop-surface-slot"
          }
        >
          <CloudProfilePage />
        </div>
        <div
          className={
            activeSurface === "web"
              ? "desktop-surface-slot is-active"
              : "desktop-surface-slot"
          }
        >
          <SurfaceFrame
            active={activeSurface === "web"}
            description="Claw-Pi workspace surface."
            crashContent={({ exitCode, reason, reload }) => (
              <DesktopWebviewCrashPanel
                exitCode={exitCode}
                onExportDiagnostics={handleExportStartupDiagnostics}
                onReload={reload}
                reason={reason}
              />
            )}
            loadingContent={
              <DesktopStartupStatusPanel
                busyAction={startupBusyAction}
                onExportDiagnostics={handleExportStartupDiagnostics}
                onRetryStartup={handleRetryStartup}
                status={startupStatus}
              />
            }
            src={desktopWebUrl}
            title="龙虾工作台"
            version={webSurfaceVersion}
            preload={getWebviewPreloadUrl()}
            inactiveUnmountDelayMs={WEB_SURFACE_INACTIVE_UNMOUNT_MS}
          />
        </div>
        <div
          className={
            activeSurface === "openclaw"
              ? "desktop-surface-slot is-active"
              : "desktop-surface-slot"
          }
        >
          <SurfaceFrame
            active={activeSurface === "openclaw"}
            description="Local OpenClaw chat surface for asking questions directly."
            mountWhenInactive={false}
            src={desktopOpenClawUrl}
            title="OpenClaw Chat"
            version={0}
          />
        </div>
        <div
          className={
            activeSurface === "diagnostics"
              ? "desktop-surface-slot is-active"
              : "desktop-surface-slot"
          }
        >
          <DiagnosticsPage runtimeConfig={runtimeConfig} />
        </div>
      </main>

      <UpdateBanner
        dismissed={update.dismissed}
        errorMessage={update.errorMessage}
        onDismiss={update.dismiss}
        onDownload={() => void update.download()}
        onInstall={() => void update.install()}
        percent={update.percent}
        phase={update.phase}
        version={update.version}
      />

      {/* Setup animation overlay — shown during first install / post-update extraction.
          Phase flow: "playing" (main 23s video) → "looping" (4s loop until ready)
                      → "fading" (0.6s opacity transition) → "done" (removed from DOM).
          If cold-start finishes during the main video, it skips straight to "fading"
          when the main video ends (no loop needed). */}
      {setupPhase !== "done" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: setupPhase === "fading" ? 0 : 1,
            transition: "opacity 0.6s ease-out",
          }}
          onTransitionEnd={() => {
            if (setupPhase === "fading") setSetupPhase("done");
          }}
        >
          {/* Draggable title bar area so window remains movable during setup */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 52,
              // @ts-expect-error Electron CSS property for window dragging
              WebkitAppRegion: "drag",
              zIndex: 1,
            }}
          />

          {/* Both videos are mounted simultaneously. The loop video preloads
              in the background while the main video plays, so the transition
              is instant — no blank gap waiting for the loop video to buffer.
              Visibility is controlled via CSS (display none/block). */}
          <video
            autoPlay
            muted
            playsInline
            src={setupVideoUrl}
            onEnded={() => {
              setSetupPhase((prev) =>
                prev === "playing"
                  ? runtimeConfig
                    ? "fading"
                    : "looping"
                  : prev,
              );
            }}
            onError={() => setSetupPhase("done")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: setupPhase === "playing" ? "block" : "none",
            }}
          />
          <video
            autoPlay
            muted
            playsInline
            loop
            src={setupLoopVideoUrl}
            onError={() => setSetupPhase("fading")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: setupPhase === "looping" ? "block" : "none",
            }}
          />
        </div>
      )}
    </div>
  );
}

function RootApp() {
  return <DesktopShell />;
}

function RendererTelemetryBootstrap() {
  useEffect(() => {
    if (rendererSentryDsn && !rendererSentryInitialized) {
      sendRendererStartupProbe("renderer:sentry-init:start", "ok");
      try {
        initializeRendererSentry(rendererSentryDsn);
        sendRendererStartupProbe("renderer:sentry-init:success", "ok");
      } catch (error) {
        sendRendererStartupProbe(
          "renderer:sentry-init:error",
          "error",
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        );
        console.error("[desktop] renderer Sentry init failed", error);
      }
    }

    if (!amplitudeApiKey || amplitudeTelemetryInitialized) {
      return;
    }

    sendRendererStartupProbe("renderer:amplitude-init:start", "ok");
    try {
      initializeAmplitudeTelemetry();
      sendRendererStartupProbe("renderer:amplitude-init:success", "ok");
    } catch (error) {
      sendRendererStartupProbe(
        "renderer:amplitude-init:error",
        "error",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      console.error("[desktop] renderer Amplitude init failed", error);
    }
  }, []);

  return null;
}

function RendererStartupSentinel() {
  useEffect(() => {
    if (rendererCommitReported) {
      return;
    }

    rendererCommitReported = true;
    sendRendererStartupProbe("renderer:react-render:committed", "ok");
  }, []);

  return null;
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  sendRendererStartupProbe("renderer:root-element-missing", "error");
  throw new Error("Root element not found");
}

sendRendererStartupProbe("renderer:react-render:start", "ok");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RendererStartupSentinel />
      <RendererTelemetryBootstrap />
      <RootApp />
    </QueryClientProvider>
  </React.StrictMode>,
);

sendRendererStartupProbe("renderer:react-render:scheduled", "ok");
