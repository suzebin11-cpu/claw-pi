import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function toPosix(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

// Mock modules before importing the module under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/Users/testuser"),
  userInfo: vi.fn(() => ({ uid: 501 })),
}));

// Mock process.platform
const originalPlatform = process.platform;

describe("LaunchdManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set platform to darwin for tests
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("throws on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    // Dynamic import to test constructor
    const { LaunchdManager } = await import(
      "../../apps/desktop/main/services/launchd-manager"
    );

    expect(() => new LaunchdManager()).toThrow(
      "LaunchdManager only works on macOS",
    );
  });

  it("uses correct default plist directory", async () => {
    const { LaunchdManager } = await import(
      "../../apps/desktop/main/services/launchd-manager"
    );

    const manager = new LaunchdManager();
    expect(toPosix(manager.getPlistDir())).toBe(
      "/Users/testuser/Library/LaunchAgents",
    );
  });

  it("uses custom plist directory when provided", async () => {
    const { LaunchdManager } = await import(
      "../../apps/desktop/main/services/launchd-manager"
    );

    const manager = new LaunchdManager({ plistDir: "/custom/path" });
    expect(manager.getPlistDir()).toBe("/custom/path");
  });

  it("constructs correct domain from UID", async () => {
    const { LaunchdManager } = await import(
      "../../apps/desktop/main/services/launchd-manager"
    );

    const manager = new LaunchdManager();
    expect(manager.getDomain()).toBe("gui/501");
  });
});

describe("SERVICE_LABELS", () => {
  it("returns correct dev labels", async () => {
    const { SERVICE_LABELS } = await import(
      "../../apps/desktop/main/services/launchd-manager"
    );

    expect(SERVICE_LABELS.controller(true)).toBe("app.clawpi.controller.dev");
    expect(SERVICE_LABELS.openclaw(true)).toBe("app.clawpi.openclaw.dev");
  });

  it("returns correct prod labels", async () => {
    const { SERVICE_LABELS } = await import(
      "../../apps/desktop/main/services/launchd-manager"
    );

    expect(SERVICE_LABELS.controller(false)).toBe("app.clawpi.controller");
    expect(SERVICE_LABELS.openclaw(false)).toBe("app.clawpi.openclaw");
  });
});
