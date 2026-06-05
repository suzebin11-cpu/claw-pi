import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProxyPolicy } from "../../apps/desktop/shared/proxy-config";
import type { DesktopRuntimeConfig } from "../../apps/desktop/shared/runtime-config";

const { mockHostname, mockMachine, mockRelease, mockSpawnSync, mockVersion } =
  vi.hoisted(() => ({
    mockHostname: vi.fn(() => "test-host"),
    mockMachine: vi.fn(() => "x86_64"),
    mockRelease: vi.fn(() => "6.8.0"),
    mockSpawnSync: vi.fn(),
    mockVersion: vi.fn(() => "Windows 11 Pro"),
  }));

const mockApp = {
  getPath: vi.fn((name: string) => {
    if (name === "exe") return "/app/Nexu.exe";
    if (name === "userData") return "/app/user-data";
    if (name === "logs") return "/app/logs";
    if (name === "crashDumps") return "/app/crash-dumps";
    return `/app/${name}`;
  }),
  getVersion: vi.fn(() => "0.3.test"),
  isPackaged: true,
};

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn(() => "/Users/testuser"),
    hostname: mockHostname,
    machine: mockMachine,
    release: mockRelease,
    version: mockVersion,
  };
});

vi.mock("electron", () => ({
  app: mockApp,
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

function createRuntimeConfig(): DesktopRuntimeConfig {
  return {
    buildInfo: {
      version: "1.0.0",
      source: "local-dev",
      branch: null,
      commit: null,
      builtAt: null,
    },
    proxy: readProxyPolicy({}),
    updates: {
      autoUpdateEnabled: true,
      channel: "stable",
    },
    ports: {
      controller: 50800,
      web: 50810,
    },
    urls: {
      controllerBase: "http://127.0.0.1:50800",
      web: "http://127.0.0.1:50810",
      openclawBase: "http://127.0.0.1:18789",
      updateFeed: null,
    },
    tokens: {
      gateway: "gw-secret-token",
    },
    paths: {
      nexuHome: "/tmp/nexu-home",
      openclawBin: "openclaw-wrapper",
    },
    desktopAuth: {
      name: "NexU Desktop",
      email: "desktop@nexu.local",
      password: "desktop-local-password",
    },
    sentryDsn: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

function createRuntimeState() {
  return {
    startedAt: "2026-06-03T00:00:00.000Z",
    units: [
      {
        id: "openclaw-runtime",
        label: "OpenClaw Runtime",
        phase: "running",
        port: 18789,
        lastError: null,
        lastReasonCode: null,
        restartCount: 0,
      },
      {
        id: "nexu-controller",
        label: "nexu Controller",
        phase: "running",
        port: 50800,
        lastError: null,
        lastReasonCode: null,
        restartCount: 0,
      },
    ],
  };
}

describe("buildMachineSummary", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHostname.mockReturnValue("test-host");
    mockMachine.mockReturnValue("x86_64");
    mockRelease.mockReturnValue("6.8.0");
    mockVersion.mockReturnValue("Windows 11 Pro");
    mockApp.getPath.mockImplementation((name: string) => {
      if (name === "exe") return "/app/Nexu.exe";
      if (name === "userData") return "/app/user-data";
      if (name === "logs") return "/app/logs";
      if (name === "crashDumps") return "/app/crash-dumps";
      return `/app/${name}`;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("uses built-in OS metadata on Windows without spawning shell commands", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mockVersion.mockReturnValue("Windows 11 Pro");
    mockMachine.mockReturnValue("AMD64");

    const { buildMachineSummary } = await import(
      "../../apps/desktop/main/diagnostics-export"
    );
    const summary = buildMachineSummary(createRuntimeConfig());
    const uname = asRecord(summary.uname);

    expect(summary.osVersion).toBe("Windows 11 Pro");
    expect(summary.platform).toBe("win32");
    expect(summary.rosetta).toBeNull();
    expect(uname).toMatchObject({
      binaryPath: "node:os.machine",
      args: [],
      ok: true,
      stdout: "AMD64",
    });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("falls back to os.release on Linux when os.version is empty", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockVersion.mockReturnValue("");
    mockRelease.mockReturnValue("6.8.0-linuxkit");
    mockMachine.mockReturnValue("x86_64");

    const { buildMachineSummary } = await import(
      "../../apps/desktop/main/diagnostics-export"
    );
    const summary = buildMachineSummary(createRuntimeConfig());
    const uname = asRecord(summary.uname);

    expect(summary.osVersion).toBe("6.8.0-linuxkit");
    expect(summary.platform).toBe("linux");
    expect(summary.rosetta).toBeNull();
    expect(uname).toMatchObject({
      binaryPath: "node:os.machine",
      args: [],
      ok: true,
      stdout: "x86_64",
    });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe("buildDiagnosticsSummary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockApp.getVersion.mockReturnValue("0.3.test");
  });

  it("classifies image openai_error failures as image response failures", async () => {
    const { buildDiagnosticsSummary } = await import(
      "../../apps/desktop/main/diagnostics-export"
    );
    const summary = buildDiagnosticsSummary({
      runtimeConfig: createRuntimeConfig(),
      runtimeState: createRuntimeState() as never,
      diagnosticText:
        "runId=img_123 gpt-image-2 /v1/images/generations returned 406 openai_error, 没有出图",
      desktopDiagnosticsSummary: null,
    });

    expect(summary.lastRunId).toBe("img_123");
    expect(summary.lastErrorCategory).toBe("image_response_lost");
    expect(summary.conclusion).toBe("本次失败原因：图片生成结果返回失败");
    expect(summary.openclawReady).toBe(true);
  });

  it("classifies balance fetch failures without treating recharge UI as insufficient balance", async () => {
    const { buildDiagnosticsSummary } = await import(
      "../../apps/desktop/main/diagnostics-export"
    );
    const summary = buildDiagnosticsSummary({
      runtimeConfig: createRuntimeConfig(),
      runtimeState: createRuntimeState() as never,
      diagnosticText:
        "recharge page: Failed to fetch balance. 余额暂时无法显示，请检查网络后重试",
      desktopDiagnosticsSummary: null,
    });

    expect(summary.lastErrorCategory).toBe("balance_unavailable");
    expect(summary.balanceStatus).toBe("unavailable");
    expect(summary.conclusion).toBe(
      "本次失败原因：余额暂时无法显示或余额接口不可用",
    );
  });

  it("keeps expired auth ahead of generic balance unavailable errors", async () => {
    const { buildDiagnosticsSummary } = await import(
      "../../apps/desktop/main/diagnostics-export"
    );
    const summary = buildDiagnosticsSummary({
      runtimeConfig: createRuntimeConfig(),
      runtimeState: createRuntimeState() as never,
      diagnosticText: "token 已过期，无法加载余额，请重新登录",
      desktopDiagnosticsSummary: null,
    });

    expect(summary.lastErrorCategory).toBe("auth_expired");
    expect(summary.balanceStatus).toBe("auth_expired");
  });

  it("classifies WeChat network failures separately from QR pending state", async () => {
    const { buildDiagnosticsSummary } = await import(
      "../../apps/desktop/main/diagnostics-export"
    );
    const summary = buildDiagnosticsSummary({
      runtimeConfig: createRuntimeConfig(),
      runtimeState: createRuntimeState() as never,
      diagnosticText: "wechat connect failed: 请检查网络后重试",
      desktopDiagnosticsSummary: null,
    });

    expect(summary.lastErrorCategory).toBe("wechat_network_error");
    expect(summary.wechatStatus).toBe("network_error");
    expect(summary.conclusion).toBe("本次失败原因：微信连接网络异常");
  });
});
