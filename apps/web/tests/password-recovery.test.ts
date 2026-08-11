import { describe, expect, it } from "vitest";
import {
  PASSWORD_RECOVERY_SUPPORT_EMAIL,
  buildPasswordRecoveryMailto,
} from "../src/lib/password-recovery";

describe("buildPasswordRecoveryMailto", () => {
  it("prefills the registered email and ownership verification guidance", () => {
    const href = buildPasswordRecoveryMailto(" user@example.com ", "zh");
    const url = new URL(href);

    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe(PASSWORD_RECOVERY_SUPPORT_EMAIL);
    expect(url.searchParams.get("subject")).toBe("Claw-Pi 密码重置申请");
    expect(url.searchParams.get("body")).toContain(
      "注册邮箱：user@example.com",
    );
    expect(url.searchParams.get("body")).toContain("请勿在邮件中提供原密码");
  });

  it("does not invent an email address when the field is empty", () => {
    const href = buildPasswordRecoveryMailto("", "en");
    const url = new URL(href);

    expect(url.searchParams.get("body")).toContain(
      "Registered email: please fill in",
    );
  });
});
