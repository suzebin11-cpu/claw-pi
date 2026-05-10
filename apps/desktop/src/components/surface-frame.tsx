import { useCallback, useRef, useState } from "react";

function ClawPiLoader({ size = 48 }: { size?: number }) {
  return (
    <>
      <svg
        width={size}
        height={size}
        viewBox="0 0 200 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Loading"
        className="clawpi-loader"
      >
        <defs>
          <linearGradient id="loader-grad" x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" stopColor="#C2F84E" />
            <stop offset="100%" stopColor="#8FEF26" />
          </linearGradient>
        </defs>
        <path
          d="M126.973367,74.611399 L126.973367,87.6539402 L140.932642,95.4497682 L140.932642,113.38067 L126.973367,113.38067 L126.973367,87.6547697 L73.0266334,87.6547697 L73.0266334,74.611399 L126.973367,74.611399 Z M109.850452,91.28956 L113.962255,95.4089558 L109.726303,99.6544386 L113.962255,103.90158 L109.850452,108.019317 L105.616155,103.773834 L101.50104,99.6594157 L105.611189,95.5300657 L109.850452,91.28956 Z M91.8508816,92.3757334 L91.8508816,106.933807 L86.0374135,106.933807 L86.0374135,92.3757334 L91.8508816,92.3757334 Z M59.0673575,87.6541061 L59.0673575,105.583349 L73.0266334,113.380836 L73.0266334,87.6541061 L59.0673575,87.6541061 Z M107.10958,126.42487 L126.973367,126.42487 L126.973367,113.3815 L107.10958,113.3815 L107.10958,126.42487 Z M73.0266334,126.42487 L93.1519596,126.42487 L93.1519596,113.3815 L73.0266334,113.3815 L73.0266334,126.42487 Z"
          fill="url(#loader-grad)"
        />
      </svg>
      <style>{`
        .clawpi-loader {
          animation: clawpi-pulse 1.8s ease-in-out infinite;
        }
        @keyframes clawpi-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.92); }
          50%      { opacity: 1;   transform: scale(1); }
        }
      `}</style>
    </>
  );
}

export function SurfaceFrame({
  title: _title,
  description: _description,
  src,
  version,
  preload,
}: {
  title: string;
  description: string;
  src: string | null;
  version: number;
  preload?: string;
}) {
  void _title;
  void _description;
  const [webviewReady, setWebviewReady] = useState(false);
  const prevSrcRef = useRef<string | null>(null);

  // Reset when src changes
  if (src !== prevSrcRef.current) {
    prevSrcRef.current = src;
    if (webviewReady) setWebviewReady(false);
  }

  const webviewRefCallback = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !src) return;
      if (preload) {
        el.setAttribute("preload", preload);
      }
      // Listen for did-finish-load right on the element before setting src.
      // This avoids the race where dom-ready fires before useEffect can bind.
      el.addEventListener("did-finish-load", () => setWebviewReady(true), {
        once: true,
      });
      el.setAttribute("src", src);
    },
    [preload, src],
  );

  const showLoader = !src || !webviewReady;

  return (
    <section className="surface-frame" style={{ position: "relative" }}>
      {/* Webview always rendered (hidden behind loader until ready) */}
      {src && (
        <webview
          ref={webviewRefCallback as React.Ref<HTMLWebViewElement>}
          className="desktop-web-frame"
          key={`${src}:${version}`}
          // @ts-expect-error Electron webview boolean attribute — must be empty string, not boolean
          allowpopups=""
          style={{ opacity: webviewReady ? 1 : 0 }}
        />
      )}

      {/* Loader overlay — covers webview until content is ready */}
      {showLoader && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "#11161d",
            zIndex: 10,
            transition: "opacity 0.3s ease-out",
          }}
        >
          <ClawPiLoader size={96} />
        </div>
      )}
    </section>
  );
}
