import { ArrowRight, Eye, EyeOff, KeyRound, LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  getApiInternalActivationStatus,
  postApiInternalActivationLogin,
  postApiInternalActivationRegister,
} from "../../lib/api/sdk.gen";
import { BrandRail } from "../components/brand-rail";
import { LanguageSwitcher } from "../components/language-switcher";
import { useLocale } from "../hooks/use-locale";
import { usePageTitle } from "../hooks/use-page-title";
import { buildPasswordRecoveryMailto } from "../lib/password-recovery";
import { track } from "../lib/tracking";

const SETUP_COMPLETE_KEY = "nexu_setup_complete";

function isSetupComplete(): boolean {
  return localStorage.getItem(SETUP_COMPLETE_KEY) === "1";
}

function isAuthPreviewMode(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  return (
    new URLSearchParams(window.location.search).get("preview-auth") === "1"
  );
}

export function markSetupComplete(): void {
  localStorage.setItem(SETUP_COMPLETE_KEY, "1");
}

function FadeIn({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div
      className={`animate-fade-in-up ${className}`}
      style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}
    >
      {children}
    </div>
  );
}

type Tab = "register" | "login";

export function WelcomePage() {
  const { locale, t } = useLocale();
  usePageTitle(t("welcome.pageTitle"));
  const navigate = useNavigate();
  const authPreviewMode = isAuthPreviewMode();

  if (!authPreviewMode && isSetupComplete()) {
    return <Navigate to="/workspace" replace />;
  }

  const [tab, setTab] = useState<Tab>("register");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authPreviewMode) {
      return;
    }

    let cancelled = false;
    const checkActivation = async () => {
      try {
        const { data } = await getApiInternalActivationStatus();
        if (cancelled) return;
        if (data?.activated) {
          markSetupComplete();
          navigate("/workspace", { replace: true });
        }
      } catch {
        /* controller not ready yet */
      }
    };
    void checkActivation();
    return () => {
      cancelled = true;
    };
  }, [authPreviewMode, navigate]);

  const handleRegister = async () => {
    if (!code.trim() || !email.trim() || !password.trim()) return;
    track("welcome_activation_register");
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const { data } = await postApiInternalActivationRegister({
        body: { code: code.trim(), email: email.trim(), password },
      });

      if (!data?.ok) {
        setErrorMessage(data?.error ?? t("welcome.activation.registerFailed"));
        toast.error(data?.error ?? t("welcome.activation.registerFailed"));
        return;
      }

      toast.success(t("welcome.activation.registerSuccess"));
      markSetupComplete();
      navigate("/workspace", { replace: true });
    } catch {
      setErrorMessage(t("welcome.activation.serverUnreachable"));
      toast.error(t("welcome.activation.serverUnreachable"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    track("welcome_activation_login");
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const { data } = await postApiInternalActivationLogin({
        body: { email: email.trim(), password },
      });

      if (!data?.ok) {
        setErrorMessage(data?.error ?? t("welcome.activation.loginFailed"));
        toast.error(data?.error ?? t("welcome.activation.loginFailed"));
        return;
      }

      toast.success(t("welcome.activation.loginSuccess"));
      markSetupComplete();
      navigate("/workspace", { replace: true });
    } catch {
      setErrorMessage(t("welcome.activation.serverUnreachable"));
      toast.error(t("welcome.activation.serverUnreachable"));
    } finally {
      setSubmitting(false);
    }
  };

  const canRegister =
    code.trim() && email.trim() && password.trim().length >= 6;
  const canLogin = email.trim() && password.trim().length >= 6;

  return (
    <div className="min-h-screen bg-[#0b0b0d] text-white relative">
      <div className="flex min-h-screen flex-col lg:flex-row">
        <BrandRail
          onLogoClick={() => navigate("/")}
          topRight={<LanguageSwitcher variant="light" size="md" />}
        />

        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#f7f5ef] px-5 py-8 text-text-primary sm:px-8 lg:px-10">
          <div className="absolute inset-0 bg-[radial-gradient(80%_80%_at_20%_15%,rgba(0,0,0,0.035),transparent_45%),radial-gradient(70%_70%_at_85%_85%,rgba(0,0,0,0.04),transparent_42%)]" />

          <div className="relative z-10 w-full max-w-[480px]">
            <nav className="mb-8 flex items-center justify-between lg:hidden">
              <button
                type="button"
                onClick={() => navigate("/")}
                className="flex items-center cursor-pointer text-accent"
              >
                <img
                  src="/logo.svg"
                  alt="Claw-Pi"
                  className="h-5 w-auto object-contain"
                />
              </button>
              <div className="flex items-center gap-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-black/40">
                  {t("welcome.mobileLabel")}
                </div>
                <LanguageSwitcher variant="dark" />
              </div>
            </nav>

            <FadeIn delay={120}>
              <div className="rounded-[32px] border border-black/10 bg-white/88 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.08)] backdrop-blur-sm sm:p-7">
                <div className="border-b border-black/8 pb-5">
                  <h2
                    className="text-[32px] leading-[0.98] tracking-tight text-[#181816] sm:text-[38px]"
                    style={{ fontFamily: "Georgia, Times New Roman, serif" }}
                  >
                    {t("welcome.activation.title")}
                  </h2>
                </div>

                {/* Tab switcher */}
                <div className="mt-5 flex rounded-2xl border border-black/8 bg-black/[0.04] p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setTab("register");
                      setErrorMessage(null);
                    }}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-all cursor-pointer ${
                      tab === "register"
                        ? "bg-[#18181b] text-white shadow-[0_4px_12px_rgba(0,0,0,0.12)]"
                        : "text-[#888] hover:text-[#1a1a1e]"
                    }`}
                  >
                    <KeyRound size={14} />
                    {t("welcome.activation.tabRegister")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTab("login");
                      setErrorMessage(null);
                    }}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-all cursor-pointer ${
                      tab === "login"
                        ? "bg-[#18181b] text-white shadow-[0_4px_12px_rgba(0,0,0,0.12)]"
                        : "text-[#888] hover:text-[#1a1a1e]"
                    }`}
                  >
                    <LogIn size={14} />
                    {t("welcome.activation.tabLogin")}
                  </button>
                </div>

                {/* Form */}
                <div className="mt-5 space-y-3">
                  {tab === "register" && (
                    <FadeIn delay={60}>
                      <div className="space-y-3">
                        <div>
                          <input
                            type="text"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder={t(
                              "welcome.activation.codePlaceholder",
                            )}
                            disabled={submitting}
                            className="w-full rounded-2xl border border-black/[0.08] bg-white px-4 py-3 text-[13px] tracking-wider text-[#1a1a1e] placeholder:text-black/30 focus:border-[#E56B2D]/40 focus:outline-none focus:ring-2 focus:ring-[#E56B2D]/10 transition-all disabled:opacity-50"
                            autoComplete="off"
                          />
                          <p className="mt-1.5 px-1 text-[11px] text-black/40">
                            {t("welcome.activation.codeHint")}
                          </p>
                        </div>

                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder={t("welcome.activation.emailPlaceholder")}
                          disabled={submitting}
                          className="w-full rounded-2xl border border-black/[0.08] bg-white px-4 py-3 text-[13px] text-[#1a1a1e] placeholder:text-black/30 focus:border-[#E56B2D]/40 focus:outline-none focus:ring-2 focus:ring-[#E56B2D]/10 transition-all disabled:opacity-50"
                          autoComplete="email"
                        />

                        <div className="relative">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t(
                              "welcome.activation.passwordPlaceholder",
                            )}
                            disabled={submitting}
                            className="w-full rounded-2xl border border-black/[0.08] bg-white px-4 py-3 pr-12 text-[13px] text-[#1a1a1e] placeholder:text-black/30 focus:border-[#E56B2D]/40 focus:outline-none focus:ring-2 focus:ring-[#E56B2D]/10 transition-all disabled:opacity-50"
                            autoComplete="new-password"
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                canRegister &&
                                !submitting
                              ) {
                                void handleRegister();
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-black/30 transition-colors hover:text-[#1a1a1e] cursor-pointer"
                          >
                            {showPassword ? (
                              <EyeOff size={14} />
                            ) : (
                              <Eye size={14} />
                            )}
                          </button>
                        </div>
                      </div>
                    </FadeIn>
                  )}

                  {tab === "login" && (
                    <FadeIn delay={60}>
                      <div className="space-y-3">
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder={t("welcome.activation.emailPlaceholder")}
                          disabled={submitting}
                          className="w-full rounded-2xl border border-black/[0.08] bg-white px-4 py-3 text-[13px] text-[#1a1a1e] placeholder:text-black/30 focus:border-[#E56B2D]/40 focus:outline-none focus:ring-2 focus:ring-[#E56B2D]/10 transition-all disabled:opacity-50"
                          autoComplete="email"
                        />

                        <div className="relative">
                          <input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t(
                              "welcome.activation.passwordPlaceholder",
                            )}
                            disabled={submitting}
                            className="w-full rounded-2xl border border-black/[0.08] bg-white px-4 py-3 pr-12 text-[13px] text-[#1a1a1e] placeholder:text-black/30 focus:border-[#E56B2D]/40 focus:outline-none focus:ring-2 focus:ring-[#E56B2D]/10 transition-all disabled:opacity-50"
                            autoComplete="current-password"
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                canLogin &&
                                !submitting
                              ) {
                                void handleLogin();
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-black/30 transition-colors hover:text-[#1a1a1e] cursor-pointer"
                          >
                            {showPassword ? (
                              <EyeOff size={14} />
                            ) : (
                              <Eye size={14} />
                            )}
                          </button>
                        </div>

                        <div className="flex items-center justify-between gap-3 px-1 text-[11px]">
                          <p className="text-black/40">
                            {t("welcome.activation.hasAccountHint")}
                          </p>
                          <a
                            href={buildPasswordRecoveryMailto(email, locale)}
                            onClick={() =>
                              track("welcome_activation_password_recovery")
                            }
                            className="shrink-0 font-medium text-[#B94F1D] transition-colors hover:text-[#8F3915]"
                          >
                            {t("welcome.activation.forgotPassword")}
                          </a>
                        </div>
                      </div>
                    </FadeIn>
                  )}
                </div>

                {/* Error message */}
                {errorMessage && (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-[12px] text-red-700">
                    {errorMessage}
                  </div>
                )}

                {/* Submit button */}
                <div className="mt-5">
                  {tab === "register" ? (
                    <button
                      type="button"
                      onClick={() => void handleRegister()}
                      disabled={!canRegister || submitting}
                      className="flex h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-[#18181b] text-[14px] font-semibold text-white transition-all hover:bg-[#18181b]/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      {submitting ? (
                        <>
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
                          {t("welcome.activation.registering")}
                        </>
                      ) : (
                        <>
                          {t("welcome.activation.registerButton")}
                          <ArrowRight size={14} />
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleLogin()}
                      disabled={!canLogin || submitting}
                      className="flex h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-[#18181b] text-[14px] font-semibold text-white transition-all hover:bg-[#18181b]/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                    >
                      {submitting ? (
                        <>
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white/80" />
                          {t("welcome.activation.loggingIn")}
                        </>
                      ) : (
                        <>
                          {t("welcome.activation.loginButton")}
                          <ArrowRight size={14} />
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Footer hint */}
                <FadeIn delay={300}>
                  <div className="mt-4 text-center text-[11px] text-black/40">
                    {tab === "register"
                      ? t("welcome.activation.hasAccountHint")
                      : t("welcome.activation.noAccountHint")}
                  </div>
                </FadeIn>

                <FadeIn delay={380}>
                  <div className="mt-4 flex items-center justify-center gap-4 border-t border-black/8 pt-4 text-[12px] text-black/40">
                    <a
                      href="https://claw-pi.cn/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cursor-pointer transition-colors hover:text-black/60"
                    >
                      {t("auth.terms")}
                    </a>
                    <span className="select-none text-black/20">·</span>
                    <a
                      href="https://claw-pi.cn/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cursor-pointer transition-colors hover:text-black/60"
                    >
                      {t("auth.privacy")}
                    </a>
                  </div>
                </FadeIn>
              </div>
            </FadeIn>
          </div>
        </div>
      </div>
    </div>
  );
}
