import { describe, expect, it } from "vitest";
import {
  findFirstNonAsciiCharacter,
  findFirstNonAsciiPath,
  formatNonAsciiPathMessage,
} from "../../apps/desktop/shared/non-ascii-path-guard";

describe("non-ASCII path guard", () => {
  it("allows ASCII-only Windows paths", () => {
    expect(findFirstNonAsciiCharacter("C:\\ClawPi\\Claw-Pi.exe")).toBeNull();
    expect(
      findFirstNonAsciiPath([
        { label: "install", path: "D:\\ClawPi" },
        {
          label: "userData",
          path: "C:\\Users\\Administrator\\AppData\\Roaming\\claw-pi-desktop",
        },
      ]),
    ).toBeNull();
  });

  it("detects the first non-ASCII path", () => {
    const issue = findFirstNonAsciiPath([
      { label: "install", path: "D:\\ClawPi" },
      { label: "resources", path: "D:\\龙虾\\Claw-Pi\\resources" },
    ]);

    expect(issue).toEqual({
      label: "resources",
      path: "D:\\龙虾\\Claw-Pi\\resources",
      character: "龙",
      codePoint: 0x9f99,
    });
  });

  it("formats a user-actionable message", () => {
    const issue = findFirstNonAsciiPath([
      { label: "user data", path: "C:\\Users\\张三\\AppData\\Roaming" },
    ]);

    expect(issue).not.toBeNull();
    if (!issue) {
      throw new Error("Expected a non-ASCII path issue.");
    }
    const message = formatNonAsciiPathMessage(issue);

    expect(message).toContain("non-ASCII");
    expect(message).toContain("C:\\Users\\张三\\AppData\\Roaming");
    expect(message).toContain("C:\\ClawPi");
    expect(message).toContain("D:\\ClawPi");
  });
});
