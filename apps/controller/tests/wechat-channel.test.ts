import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { compileChannelsConfig } from "../src/lib/channel-binding-compiler.js";
import { OpenClawConfigWriter } from "../src/runtime/openclaw-config-writer.js";
import { ChannelService } from "../src/services/channel-service.js";
import type { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";
import type { OpenClawSyncService } from "../src/services/openclaw-sync-service.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function createEnv(stateDir: string): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuHomeDir: path.join(stateDir, "nexu-home"),
    nexuConfigPath: path.join(stateDir, "nexu-home", "config.json"),
    artifactsIndexPath: path.join(stateDir, "artifacts", "index.json"),
    compiledOpenclawSnapshotPath: path.join(stateDir, "compiled-openclaw.json"),
    openclawStateDir: stateDir,
    openclawConfigPath: path.join(stateDir, "openclaw.json"),
    openclawSkillsDir: path.join(stateDir, "skills"),
    openclawWorkspaceTemplatesDir: path.join(stateDir, "workspace-templates"),
    openclawBin: "openclaw",
    openclawGatewayPort: 18789,
    openclawGatewayToken: "token-123",
    manageOpenclawProcess: false,
    gatewayProbeEnabled: false,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "link/gemini-3-flash-preview",
  } as unknown as ControllerEnv;
}

function makeChannel(
  overrides: Partial<{
    id: string;
    channelType: string;
    accountId: string;
    status: string;
  }> = {},
) {
  return {
    id: overrides.id ?? "ch-1",
    botId: "bot-1",
    channelType: overrides.channelType ?? "wechat",
    accountId: overrides.accountId ?? "abc123-im-bot",
    status: overrides.status ?? "connected",
    teamName: null,
    appId: null,
    botUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// WeChat prewarm config compilation
// ---------------------------------------------------------------------------

describe("WeChat prewarm config compilation", () => {
  it("includes enabled openclaw-weixin with prewarm account when no WeChat channels exist", () => {
    const result = compileChannelsConfig({
      channels: [],
      secrets: {},
      controllerBaseUrl: "http://127.0.0.1:3010",
    });

    // The subtree must exist and stay enabled so the desktop app prepares the
    // WeChat runtime on open. Adding the first real account then becomes a
    // hot account swap instead of a section-add restart.
    expect(result["openclaw-weixin"]).toBeDefined();
    expect(result["openclaw-weixin"]?.enabled).toBe(true);
    expect(
      result["openclaw-weixin"]?.accounts.__nexu_internal_wechat_prewarm__,
    ).toEqual({ enabled: false });
  });

  it("replaces prewarm with real account when WeChat channel is connected", () => {
    const result = compileChannelsConfig({
      channels: [makeChannel({ accountId: "real-account-id" })],
      secrets: {},
      controllerBaseUrl: "http://127.0.0.1:3010",
    });

    expect(result["openclaw-weixin"]?.enabled).toBe(true);
    expect(result["openclaw-weixin"]?.accounts["real-account-id"]).toEqual({
      enabled: true,
    });
    expect(
      result["openclaw-weixin"]?.accounts.__nexu_internal_wechat_prewarm__,
    ).toBeUndefined();
  });

  it("does not include prewarm when a real WeChat account exists", () => {
    const result = compileChannelsConfig({
      channels: [makeChannel()],
      secrets: {},
      controllerBaseUrl: "http://127.0.0.1:3010",
    });

    const accountKeys = Object.keys(result["openclaw-weixin"]?.accounts);
    expect(accountKeys).not.toContain("__nexu_internal_wechat_prewarm__");
    expect(accountKeys).toHaveLength(1);
    expect(result["openclaw-weixin"]?.enabled).toBe(true);
  });

  it("ignores disconnected WeChat channels and keeps enabled prewarm", () => {
    const result = compileChannelsConfig({
      channels: [makeChannel({ status: "disconnected" })],
      secrets: {},
      controllerBaseUrl: "http://127.0.0.1:3010",
    });

    // Disconnected channel should not become an active account, but WeChat
    // runtime remains prepared for a reconnect.
    expect(result["openclaw-weixin"]?.enabled).toBe(true);
    expect(
      result["openclaw-weixin"]?.accounts.__nexu_internal_wechat_prewarm__,
    ).toEqual({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// WeChat connect/disconnect lifecycle
// ---------------------------------------------------------------------------

describe("WeChat connect/disconnect lifecycle", () => {
  let tmpDir: string;
  let env: ControllerEnv;
  let service: ChannelService;
  let configStore: {
    connectWechat: ReturnType<typeof vi.fn>;
    disconnectChannel: ReturnType<typeof vi.fn>;
    getChannel: ReturnType<typeof vi.fn>;
    setChannelStatus: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  let syncService: {
    writePlatformTemplatesForBot: ReturnType<typeof vi.fn>;
    syncAll: ReturnType<typeof vi.fn>;
    syncAllImmediate: ReturnType<typeof vi.fn>;
  };
  let gatewayService: {
    getChannelReadiness: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `nexu-wechat-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    env = createEnv(tmpDir);

    configStore = {
      connectWechat: vi.fn().mockResolvedValue(makeChannel()),
      disconnectChannel: vi.fn().mockResolvedValue(true),
      getChannel: vi.fn().mockResolvedValue(makeChannel()),
      setChannelStatus: vi.fn().mockResolvedValue(makeChannel()),
    };
    syncService = {
      writePlatformTemplatesForBot: vi.fn().mockResolvedValue(undefined),
      syncAll: vi.fn().mockResolvedValue(undefined),
      syncAllImmediate: vi.fn().mockResolvedValue({ configPushed: true }),
    };
    gatewayService = {
      getChannelReadiness: vi.fn().mockResolvedValue({ ready: true }),
    };

    service = new ChannelService(
      env,
      configStore as unknown as NexuConfigStore,
      syncService as unknown as OpenClawSyncService,
      gatewayService as unknown as OpenClawGatewayService,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connectWechat persists the new account without blocking on readiness", async () => {
    const channel = await service.connectWechat("test-account");

    expect(configStore.connectWechat).toHaveBeenCalledWith({
      accountId: "test-account",
    });
    expect(syncService.writePlatformTemplatesForBot).toHaveBeenCalledWith(
      "bot-1",
    );
    expect(syncService.syncAll).not.toHaveBeenCalled();
    expect(syncService.syncAllImmediate).toHaveBeenCalledTimes(1);
    expect(gatewayService.getChannelReadiness).not.toHaveBeenCalled();
    expect(channel.channelType).toBe("wechat");
  });

  it("connectWechat does not fail or rollback on slow runtime startup", async () => {
    gatewayService.getChannelReadiness.mockResolvedValue({
      ready: false,
      connected: false,
      running: false,
      configured: false,
      gatewayConnected: true,
      lastError: "monitor failed to start",
    });

    const channel = await service.connectWechat("slow-account");

    expect(channel.channelType).toBe("wechat");
    expect(configStore.disconnectChannel).not.toHaveBeenCalled();
    expect(syncService.syncAllImmediate).toHaveBeenCalledTimes(1);
    expect(gatewayService.getChannelReadiness).not.toHaveBeenCalled();
  });

  it("marks expired WeChat sessions as channel errors and syncs immediately", async () => {
    const changed = await service.reconcileExpiredWechatSessions([
      {
        channelType: "wechat",
        channelId: "ch-1",
        accountId: "expired-account",
        status: "error",
        ready: false,
        connected: false,
        running: false,
        configured: false,
        lastError: "session expired",
      },
    ]);

    expect(changed).toBe(true);
    expect(configStore.setChannelStatus).toHaveBeenCalledWith("ch-1", "error");
    expect(syncService.syncAllImmediate).toHaveBeenCalledTimes(1);
  });

  it("confirmed QR login activates the new account without deleting old account context", async () => {
    const accountsDir = path.join(tmpDir, "openclaw-weixin", "accounts");
    const indexPath = path.join(tmpDir, "openclaw-weixin", "accounts.json");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(["old-account"]));
    writeFileSync(
      path.join(accountsDir, "old-account.json"),
      JSON.stringify({ token: "old" }),
    );
    writeFileSync(
      path.join(accountsDir, "old-account.sync.json"),
      JSON.stringify({ get_updates_buf: "old-buf" }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("get_bot_qrcode")) {
          return new Response(
            JSON.stringify({
              qrcode: "qr-token",
              qrcode_img_content: "data:image/png;base64,abc",
            }),
            { status: 200 },
          );
        }
        if (url.includes("get_qrcode_status")) {
          return new Response(
            JSON.stringify({
              status: "confirmed",
              bot_token: "new-token",
              ilink_bot_id: "new-account",
              baseurl: "https://ilinkai.weixin.qq.com",
              ilink_user_id: "user-1",
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const started = await service.wechatQrStart();
    const result = await service.wechatQrWait(started.sessionKey ?? "");

    expect(result).toMatchObject({
      connected: true,
      accountId: "new-account",
    });
    expect(JSON.parse(readFileSync(indexPath, "utf-8"))).toEqual([
      "new-account",
    ]);
    expect(existsSync(path.join(accountsDir, "old-account.json"))).toBe(true);
    expect(existsSync(path.join(accountsDir, "old-account.sync.json"))).toBe(
      true,
    );
    expect(
      JSON.parse(
        readFileSync(path.join(accountsDir, "new-account.json"), "utf-8"),
      ),
    ).toMatchObject({ token: "new-token" });
  });

  it("keeps a QR login pending after a short wait window without activating an account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const accountsDir = path.join(tmpDir, "openclaw-weixin", "accounts");
    const indexPath = path.join(tmpDir, "openclaw-weixin", "accounts.json");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify([]));
    let confirmed = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("get_bot_qrcode")) {
          return new Response(
            JSON.stringify({
              qrcode: "qr-token",
              qrcode_img_content: "data:image/png;base64,abc",
            }),
            { status: 200 },
          );
        }
        if (url.includes("get_qrcode_status")) {
          if (confirmed) {
            return new Response(
              JSON.stringify({
                status: "confirmed",
                bot_token: "new-token",
                ilink_bot_id: "new-account",
                baseurl: "https://ilinkai.weixin.qq.com",
                ilink_user_id: "user-1",
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ status: "wait" }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const started = await service.wechatQrStart();
    const waitPromise = service.wechatQrWait(started.sessionKey ?? "");

    await vi.advanceTimersByTimeAsync(36_000);
    const result = await waitPromise;

    expect(result).toEqual({
      connected: false,
      message:
        "仍在等待手机微信扫码/确认。如果手机端提示“请检查网络”，请重新生成二维码，或切换手机网络后再试。",
      pending: true,
    });
    expect(JSON.parse(readFileSync(indexPath, "utf-8"))).toEqual([]);
    expect(existsSync(path.join(accountsDir, "new-account.json"))).toBe(false);

    confirmed = true;
    const confirmedResult = await service.wechatQrWait(
      started.sessionKey ?? "",
    );
    expect(confirmedResult).toMatchObject({
      connected: true,
      accountId: "new-account",
    });
    expect(JSON.parse(readFileSync(indexPath, "utf-8"))).toEqual([
      "new-account",
    ]);
  });

  it("QR wait does not let a long-poll request exceed the total deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("get_bot_qrcode")) {
          return new Response(
            JSON.stringify({
              qrcode: "qr-token",
              qrcode_img_content: "data:image/png;base64,abc",
            }),
            { status: 200 },
          );
        }
        if (url.includes("get_qrcode_status")) {
          statusCalls += 1;
          if (statusCalls === 1) {
            return new Promise<Response>((resolve) => {
              setTimeout(() => {
                resolve(
                  new Response(JSON.stringify({ status: "wait" }), {
                    status: 200,
                  }),
                );
              }, 30_000);
            });
          }

          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const started = await service.wechatQrStart();
    const waitPromise = service.wechatQrWait(started.sessionKey ?? "");

    await vi.advanceTimersByTimeAsync(36_000);

    await expect(waitPromise).resolves.toEqual({
      connected: false,
      message:
        "仍在等待手机微信扫码/确认。如果手机端提示“请检查网络”，请重新生成二维码，或切换手机网络后再试。",
      pending: true,
    });
    expect(statusCalls).toBe(2);
  });

  it("QR wait retries transient poll failures instead of failing the login flow", async () => {
    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("get_bot_qrcode")) {
          return new Response(
            JSON.stringify({
              qrcode: "qr-token",
              qrcode_img_content: "data:image/png;base64,abc",
            }),
            { status: 200 },
          );
        }
        if (url.includes("get_qrcode_status")) {
          statusCalls += 1;
          if (statusCalls === 1) {
            const error = new Error("network unstable");
            error.name = "TimeoutError";
            throw error;
          }
          return new Response(
            JSON.stringify({
              status: "confirmed",
              bot_token: "new-token",
              ilink_bot_id: "new-account",
              baseurl: "https://ilinkai.weixin.qq.com",
              ilink_user_id: "user-1",
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const started = await service.wechatQrStart();
    const result = await service.wechatQrWait(started.sessionKey ?? "");

    expect(result).toMatchObject({
      connected: true,
      accountId: "new-account",
    });
    expect(statusCalls).toBe(2);
  });

  it("disconnectChannel calls syncAll after unbinding", async () => {
    await service.disconnectChannel("ch-1");

    expect(configStore.disconnectChannel).toHaveBeenCalledWith("ch-1");
    expect(syncService.syncAll).toHaveBeenCalled();
  });

  it("disconnectChannel does not delete credential files directly", async () => {
    const accountsDir = path.join(tmpDir, "openclaw-weixin", "accounts");
    mkdirSync(accountsDir, { recursive: true });
    writeFileSync(
      path.join(accountsDir, "abc123-im-bot.json"),
      JSON.stringify({ token: "tok" }),
    );

    await service.disconnectChannel("ch-1");

    expect(existsSync(path.join(accountsDir, "abc123-im-bot.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncWeixinAccountIndex (config writer)
// ---------------------------------------------------------------------------

describe("syncWeixinAccountIndex via OpenClawConfigWriter", () => {
  let tmpDir: string;
  let env: ControllerEnv;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `nexu-writer-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    env = createEnv(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not persist internal prewarm account ID to index", async () => {
    const writer = new OpenClawConfigWriter(env);
    const indexPath = path.join(tmpDir, "openclaw-weixin", "accounts.json");

    // Write config that includes the prewarm account (as compiler would produce)
    await writer.write({
      channels: {
        "openclaw-weixin": {
          enabled: true,
          accounts: {
            __nexu_internal_wechat_prewarm__: { enabled: false },
          },
        },
      },
    } as never);

    // Index should not contain the prewarm ID
    if (existsSync(indexPath)) {
      const ids = JSON.parse(readFileSync(indexPath, "utf-8"));
      expect(ids).not.toContain("__nexu_internal_wechat_prewarm__");
    }
  });

  it("removes stale account IDs not in current config", async () => {
    const indexDir = path.join(tmpDir, "openclaw-weixin");
    const indexPath = path.join(indexDir, "accounts.json");
    mkdirSync(indexDir, { recursive: true });

    // Seed index with stale IDs from previous sessions
    writeFileSync(
      indexPath,
      JSON.stringify(["stale-1", "stale-2", "current-account"]),
    );

    const writer = new OpenClawConfigWriter(env);
    await writer.write({
      channels: {
        "openclaw-weixin": {
          enabled: true,
          accounts: {
            "current-account": { enabled: true },
          },
        },
      },
    } as never);

    const ids = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(ids).toEqual(["current-account"]);
  });

  it("handles empty config accounts gracefully", async () => {
    const indexDir = path.join(tmpDir, "openclaw-weixin");
    const indexPath = path.join(indexDir, "accounts.json");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(["old-account"]));

    const writer = new OpenClawConfigWriter(env);
    await writer.write({
      channels: {
        "openclaw-weixin": {
          enabled: true,
          accounts: {},
        },
      },
    } as never);

    const ids = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(ids).toEqual([]);
  });

  it("preserves orphan credential files while removing orphan IDs from the active index", async () => {
    const indexDir = path.join(tmpDir, "openclaw-weixin");
    const accountsDir = path.join(indexDir, "accounts");
    mkdirSync(accountsDir, { recursive: true });

    // Seed orphan credential + sync files from a previously disconnected account
    writeFileSync(
      path.join(accountsDir, "orphan-acct.json"),
      JSON.stringify({ token: "old" }),
    );
    writeFileSync(
      path.join(accountsDir, "orphan-acct.sync.json"),
      JSON.stringify({ get_updates_buf: "buf" }),
    );
    // Also seed a valid account's files
    writeFileSync(
      path.join(accountsDir, "current-acct.json"),
      JSON.stringify({ token: "valid" }),
    );

    const writer = new OpenClawConfigWriter(env);
    await writer.write({
      channels: {
        "openclaw-weixin": {
          enabled: true,
          accounts: { "current-acct": { enabled: true } },
        },
      },
    } as never);

    const ids = JSON.parse(
      readFileSync(path.join(indexDir, "accounts.json"), "utf-8"),
    );
    expect(ids).toEqual(["current-acct"]);
    // Historical files are preserved so a fresh QR scan can reconnect context.
    expect(existsSync(path.join(accountsDir, "orphan-acct.json"))).toBe(true);
    expect(existsSync(path.join(accountsDir, "orphan-acct.sync.json"))).toBe(
      true,
    );
    // Current account files preserved
    expect(existsSync(path.join(accountsDir, "current-acct.json"))).toBe(true);
  });
});
