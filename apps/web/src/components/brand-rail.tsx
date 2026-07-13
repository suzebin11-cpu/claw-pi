import {
  Infinity as InfinityIcon,
  Shield,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "../hooks/use-locale";


function NexuIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Claw-Pi"
    >
      <path
        d="M126.973367,74.611399 L126.973367,87.6539402 L140.932642,95.4497682 L140.932642,113.38067 L126.973367,113.38067 L126.973367,87.6547697 L73.0266334,87.6547697 L73.0266334,74.611399 L126.973367,74.611399 Z M109.850452,91.28956 L113.962255,95.4089558 L109.726303,99.6544386 L113.962255,103.90158 L109.850452,108.019317 L105.616155,103.773834 L101.50104,99.6594157 L105.611189,95.5300657 L109.850452,91.28956 Z M91.8508816,92.3757334 L91.8508816,106.933807 L86.0374135,106.933807 L86.0374135,92.3757334 L91.8508816,92.3757334 Z M59.0673575,87.6541061 L59.0673575,105.583349 L73.0266334,113.380836 L73.0266334,87.6541061 L59.0673575,87.6541061 Z M107.10958,126.42487 L126.973367,126.42487 L126.973367,113.3815 L107.10958,113.3815 L107.10958,126.42487 Z M73.0266334,126.42487 L93.1519596,126.42487 L93.1519596,113.3815 L73.0266334,113.3815 L73.0266334,126.42487 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function NexuLogoWhite({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 500 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Claw-Pi logo"
    >
      <defs>
        <linearGradient id="brand-grad-1" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#C2F84E" />
          <stop offset="100%" stopColor="#8FEF26" />
        </linearGradient>
        <linearGradient id="brand-grad-2" x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%" stopColor="#C2F84E" />
          <stop offset="100%" stopColor="#8FEF26" />
        </linearGradient>
      </defs>
      <g transform="translate(114, 74)">
        <path
          d="M67.906,0 L67.906,13.042 L81.865,20.838 L81.865,38.769 L67.906,38.769 L67.906,13.043 L13.959,13.043 L13.959,0 L67.906,0 Z M50.783,16.678 L54.895,20.798 L50.659,25.043 L54.895,29.29 L50.783,33.408 L46.549,29.162 L42.434,25.048 L46.544,20.919 L50.783,16.678 Z M32.784,17.764 L32.784,32.322 L26.97,32.322 L26.97,17.764 L32.784,17.764 Z M0,13.043 L0,30.972 L13.959,38.769 L13.959,13.043 L0,13.043 Z M48.042,51.813 L67.906,51.813 L67.906,38.77 L48.042,38.77 L48.042,51.813 Z M13.959,51.813 L34.085,51.813 L34.085,38.77 L13.959,38.77 L13.959,51.813 Z"
          fill="url(#brand-grad-1)"
        />
        <g transform="translate(99.484, 5.178)">
          <path
            d="M38.393,41.425 L46.4,41.425 L46.4,0.004 L38.393,0.004 L38.393,41.425 Z M63.97,14.133 C66.322,14.133 68.254,14.429 69.767,15.021 C71.28,15.613 72.491,16.472 73.401,17.621 C74.306,18.752 74.938,20.156 75.293,21.82 C75.647,23.478 75.824,25.397 75.824,27.57 L75.824,41.435 L68.461,41.435 L68.461,37.526 L68.349,37.526 C67.462,38.918 66.274,39.919 64.797,40.523 C63.32,41.127 61.765,41.435 60.129,41.435 C58.917,41.435 57.753,41.263 56.63,40.925 C55.507,40.582 54.52,40.073 53.663,39.397 C52.812,38.722 52.133,37.881 51.636,36.886 C51.134,35.886 50.886,34.725 50.886,33.404 C50.886,31.906 51.164,30.644 51.713,29.602 C52.263,28.571 53.013,27.713 53.959,27.037 C54.904,26.356 55.974,25.829 57.186,25.456 C58.397,25.077 59.656,24.805 60.956,24.627 C62.256,24.449 63.556,24.343 64.856,24.301 C66.156,24.266 67.356,24.254 68.461,24.254 C68.461,22.827 67.953,21.69 66.936,20.849 C65.92,20.014 64.72,19.593 63.332,19.593 C62.014,19.593 60.814,19.877 59.727,20.422 C58.639,20.973 57.67,21.737 56.819,22.702 L52.541,18.314 C54.036,16.916 55.779,15.874 57.776,15.181 C59.768,14.482 61.836,14.133 63.97,14.133 Z M68.461,29.389 L66.481,29.389 C65.879,29.389 65.116,29.418 64.212,29.472 C63.302,29.519 62.433,29.679 61.594,29.928 C60.761,30.176 60.046,30.549 59.461,31.047 C58.87,31.55 58.574,32.243 58.574,33.138 C58.574,34.097 58.988,34.814 59.803,35.276 C60.625,35.743 61.476,35.968 62.368,35.968 C63.154,35.968 63.905,35.868 64.638,35.655 C65.37,35.441 66.02,35.139 66.588,34.737 C67.161,34.346 67.61,33.854 67.953,33.238 C68.29,32.634 68.461,31.929 68.461,31.1 L68.461,29.389 Z M77.747,14.135 L86.293,14.135 L91.582,31.262 L91.688,31.262 L96.12,14.135 L104.878,14.135 L109.683,31.262 L109.789,31.262 L114.653,14.135 L122.767,14.135 L113.53,41.431 L105.629,41.431 L100.233,23.291 L100.127,23.291 L95.323,41.431 L87.256,41.431 L77.747,14.135 Z M20.489,33.372 C13.568,33.372 7.96,27.704 7.96,20.71 C7.96,13.722 13.568,8.048 20.489,8.048 C23.644,8.048 26.493,9.268 28.697,11.216 L33.915,5.181 C30.31,1.995 25.654,0.005 20.489,0.005 C9.172,0.005 0,9.274 0,20.71 C0,32.146 9.172,41.421 20.489,41.421 C25.654,41.421 30.31,39.425 33.915,36.244 L28.697,30.209 C26.493,32.152 23.644,33.372 20.489,33.372"
            fill="#FFFFFF"
          />
          <path
            d="M139.038,18.271 L147.802,18.271 C148.89,18.271 149.959,18.14 151.017,17.892 C152.063,17.631 152.997,17.228 153.818,16.666 C154.634,16.097 155.296,15.339 155.798,14.403 C156.306,13.468 156.566,12.319 156.566,10.95 C156.566,9.624 156.3,8.493 155.774,7.557 C155.242,6.621 154.569,5.845 153.73,5.241 C152.89,4.637 151.927,4.199 150.84,3.927 C149.741,3.654 148.653,3.512 147.566,3.512 L139.038,3.512 L139.038,18.271 Z M135.179,0 L147.099,0 C148.541,0 150.048,0.172 151.626,0.503 C153.21,0.835 154.64,1.41 155.952,2.233 C157.252,3.044 158.321,4.169 159.161,5.597 C160,7.018 160.413,8.813 160.413,10.95 C160.413,12.828 160.077,14.445 159.391,15.807 C158.717,17.181 157.795,18.3 156.655,19.177 C155.503,20.053 154.173,20.711 152.678,21.137 C151.177,21.569 149.617,21.783 147.98,21.783 L139.038,21.783 L139.038,41.457 L135.179,41.457 L135.179,0 Z M168.15,41.454 L171.661,41.454 L171.661,14.407 L168.15,14.407 L168.15,41.454 Z"
            fill="#FFFFFF"
          />
          <path
            d="M166.75,3.166 C166.75,2.272 167.051,1.526 167.66,0.916 C168.268,0.306 169.013,0.004 169.905,0.004 C170.792,0.004 171.536,0.306 172.151,0.916 C172.76,1.526 173.055,2.272 173.055,3.166 C173.055,4.054 172.76,4.801 172.151,5.411 C171.536,6.021 170.792,6.323 169.905,6.323 C169.013,6.323 168.268,6.021 167.66,5.411 C167.051,4.801 166.75,4.054 166.75,3.166 Z"
            fill="url(#brand-grad-2)"
          />
        </g>
      </g>
    </svg>
  );
}

function FadeIn({
  children,
  delay = 0,
  className = "",
}: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div
      className={`animate-fade-in-up ${className}`}
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}
    >
      {children}
    </div>
  );
}

export function BrandRail({
  topRight,
  onLogoClick,
}: {
  topRight?: ReactNode;
  onLogoClick: () => void;
}) {
  const { t } = useLocale();
  const bullets = [
    { icon: Sparkles, text: t("brand.bullet.openclaw") },
    { icon: Shield, text: t("brand.bullet.feishu") },
    { icon: InfinityIcon, text: t("brand.bullet.models") },
  ];

  return (
    <div className="hidden lg:flex lg:w-[46%] lg:min-h-screen relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_18%_18%,rgba(255,255,255,0.08),transparent_36%),radial-gradient(80%_80%_at_82%_22%,rgba(180,150,255,0.14),transparent_36%),linear-gradient(180deg,#0d0d10_0%,#0a0a0d_100%)]" />
      <div className="absolute -right-20 bottom-0 opacity-[0.05]">
        <NexuIcon className="h-[360px] w-[360px] text-white" />
      </div>

      <div className="relative z-10 flex w-full flex-col justify-between px-10 pb-12 pt-8 xl:px-12 xl:py-12">
        <FadeIn delay={80} className="flex items-center justify-between">
          <button
            type="button"
            onClick={onLogoClick}
            className="flex items-center cursor-pointer"
          >
            <NexuLogoWhite className="h-8 w-auto text-white xl:h-9" />
          </button>
          {topRight ?? <div />}
        </FadeIn>

        <div>
          <FadeIn delay={220}>
            <h1
              className="max-w-[560px] text-[40px] leading-[0.96] tracking-tight text-white sm:text-[52px] lg:text-[64px]"
              style={{ fontFamily: "Georgia, Times New Roman, serif" }}
            >
              {t("brand.title.line1")}
              <br />
              {t("brand.title.line2")}
            </h1>
          </FadeIn>

          <FadeIn delay={300}>
            <p className="mt-6 max-w-[460px] text-[15px] leading-[1.8] text-white/58">
              {t("brand.body")}
            </p>
          </FadeIn>

          <div className="mt-8 space-y-3">
            {bullets.map((item, index) => (
              <FadeIn key={item.text} delay={380 + index * 80}>
                <div className="grid min-h-[72px] grid-cols-[40px_1fr] items-center gap-4 rounded-2xl border border-white/8 bg-white/[0.025] px-5 py-4">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/[0.06]">
                    <item.icon size={15} className="text-white/66" />
                  </div>
                  <p className="text-[13px] leading-[1.6] text-white/58">
                    {item.text}
                  </p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>

        <div />
      </div>
    </div>
  );
}
