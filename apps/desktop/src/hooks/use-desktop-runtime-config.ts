import { useEffect, useMemo, useState } from "react";
import type { DesktopRuntimeConfig } from "../../shared/host";
import { getRuntimeConfig } from "../lib/host-api";

export function useDesktopRuntimeConfig() {
  const [runtimeConfig, setRuntimeConfig] =
    useState<DesktopRuntimeConfig | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const [openclawReady, setOpenclawReady] = useState(false);

  useEffect(() => {
    void getRuntimeConfig()
      .then(setRuntimeConfig)
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!runtimeConfig) return;
    if (apiReady) return;

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
            const data = await res.json();
            if (data.ready) {
              if (!cancelled) setApiReady(true);
              return;
            }
          }
        } catch {
          // API or web sidecar not ready yet — keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [runtimeConfig, apiReady]);

  useEffect(() => {
    const openclawBase = runtimeConfig?.urls.openclawBase;
    if (!openclawBase) {
      setOpenclawReady(false);
      return;
    }

    let cancelled = false;
    setOpenclawReady(false);

    const readyUrl = new URL("/chat", openclawBase).toString();

    async function poll() {
      while (!cancelled) {
        try {
          await fetch(readyUrl, {
            cache: "no-store",
            mode: "no-cors",
            signal: AbortSignal.timeout(3000),
          });
          if (!cancelled) {
            setOpenclawReady(true);
          }
          return;
        } catch {
          // OpenClaw gateway is still booting — do not mount a failing webview yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [runtimeConfig?.urls.openclawBase]);

  const desktopWebUrl = useMemo(() => {
    if (!runtimeConfig || !apiReady) {
      return null;
    }

    return new URL("/workspace", runtimeConfig.urls.web).toString();
  }, [apiReady, runtimeConfig]);

  const desktopOpenClawUrl = useMemo(() => {
    if (!runtimeConfig || !openclawReady) {
      return null;
    }

    return new URL(
      `/chat#token=${encodeURIComponent(runtimeConfig.tokens.gateway)}`,
      runtimeConfig.urls.openclawBase,
    ).toString();
  }, [openclawReady, runtimeConfig]);

  return {
    apiReady,
    desktopOpenClawUrl,
    desktopWebUrl,
    openclawReady,
    runtimeConfig,
  };
}
