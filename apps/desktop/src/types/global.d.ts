import type { HostBridge, UpdaterBridge } from "@shared/host";
import type * as React from "react";

declare global {
  interface Window {
    clawpiHost: HostBridge;
    clawpiUpdater?: UpdaterBridge;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        src?: string;
        partition?: string;
        allowpopups?: string | boolean;
      };
    }
  }
}

export {};
