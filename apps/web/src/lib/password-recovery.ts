export const PASSWORD_RECOVERY_SUPPORT_EMAIL = "support@nexu.ai";

export function buildPasswordRecoveryMailto(
  email: string,
  locale: "en" | "zh",
): string {
  const registeredEmail = email.trim();
  const subject =
    locale === "zh" ? "Claw-Pi 密码重置申请" : "Claw-Pi password reset request";
  const body =
    locale === "zh"
      ? [
          "请协助重置我的 Claw-Pi 账号密码。",
          "",
          `注册邮箱：${registeredEmail || "请填写"}`,
          "",
          "为核验账号归属，请使用注册邮箱发送本邮件。请勿在邮件中提供原密码或其他密码。",
        ].join("\n")
      : [
          "Please help reset my Claw-Pi account password.",
          "",
          `Registered email: ${registeredEmail || "please fill in"}`,
          "",
          "To verify account ownership, send this message from the registered email address. Do not include your old password or any other password.",
        ].join("\n");

  return `mailto:${PASSWORD_RECOVERY_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
