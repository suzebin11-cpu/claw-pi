import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import type { DesktopChromeMode, DesktopSurface } from "../../shared/host";
import { useAutoUpdate } from "../hooks/use-auto-update";
import { useDesktopRuntimeConfig } from "../hooks/use-desktop-runtime-config";
import { onDesktopCommand } from "../lib/host-api";
import {
  formatBuildCommit,
  formatBuildTimestamp,
} from "../lib/runtime-formatters";
import { DiagnosticsPage } from "../pages/diagnostics-page";
import { RuntimePage } from "../pages/runtime-page";
import { SurfaceButton } from "./surface-button";
import { SurfaceFrame } from "./surface-frame";
import { UpdateBanner } from "./update-banner";

function getWebviewPreloadUrl(): string {
  return new URL(
    "../dist-electron/preload/webview-preload.js",
    document.location.href,
  ).href;
}

export function DesktopShell() {
  const isPackaged = window.clawpiHost.bootstrap.isPackaged;
  const isMacOS =
    typeof navigator !== "undefined" && navigator.platform?.startsWith("Mac");
  const [activeSurface, setActiveSurface] = useState<DesktopSurface>("web");
  const [chromeMode, setChromeMode] = useState<DesktopChromeMode>(
    isPackaged ? "immersive" : "full",
  );
  const shellClassName = [
    chromeMode === "immersive" ? "desktop-shell is-immersive" : "desktop-shell",
    isMacOS ? "desktop-shell--mac" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const webSurfaceVersion = 0;
  const { desktopOpenClawUrl, desktopWebUrl, openclawReady, runtimeConfig } =
    useDesktopRuntimeConfig();
  const update = useAutoUpdate();
  const { check: checkForUpdates } = update;

  useEffect(() => {
    return onDesktopCommand((command) => {
      if (command.type === "desktop:check-for-updates") {
        void checkForUpdates();
        return;
      }
      if (command.type === "setup:complete") {
        return;
      }

      setActiveSurface(command.surface);
      setChromeMode(command.chromeMode);
    });
  }, [checkForUpdates]);

  return (
    <div className={shellClassName}>
      {isMacOS && <div className="window-drag-bar" />}
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
            active={activeSurface === "web"}
            disabled={!desktopWebUrl}
            label="龙虾工作台"
            meta="打开主工作台界面"
            onClick={() => setActiveSurface("web")}
          />
          <SurfaceButton
            active={activeSurface === "openclaw"}
            disabled={!openclawReady}
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
          style={{ display: activeSurface === "control" ? "contents" : "none" }}
        >
          <>
            <RuntimePage />
            <Toaster position="top-right" />
          </>
        </div>
        <div style={{ display: activeSurface === "web" ? "contents" : "none" }}>
          <SurfaceFrame
            active={activeSurface === "web"}
            description="Claw-Pi workspace surface."
            src={desktopWebUrl}
            title="龙虾工作台"
            version={webSurfaceVersion}
            preload={getWebviewPreloadUrl()}
          />
        </div>
        <div
          style={{
            display: activeSurface === "openclaw" ? "contents" : "none",
          }}
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
          style={{
            display: activeSurface === "diagnostics" ? "contents" : "none",
          }}
        >
          <DiagnosticsPage />
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
    </div>
  );
}
