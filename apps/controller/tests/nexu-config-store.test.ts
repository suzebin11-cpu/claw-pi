import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { NexuConfigStore } from "../src/store/nexu-config-store.js";

describe("NexuConfigStore", () => {
  let rootDir = "";
  let env: ControllerEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-controller-"));
    env = {
      nodeEnv: "test",
      port: 3010,
      host: "127.0.0.1",
      webUrl: "http://localhost:5173",
      nexuCloudUrl: "https://nexu.io",
      nexuLinkUrl: "https://link.nexu.io",
      nexuHomeDir: path.join(rootDir, ".nexu"),
      nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
      artifactsIndexPath: path.join(
        rootDir,
        ".nexu",
        "artifacts",
        "index.json",
      ),
      compiledOpenclawSnapshotPath: path.join(
        rootDir,
        ".nexu",
        "compiled-openclaw.json",
      ),
      openclawStateDir: path.join(rootDir, ".openclaw"),
      openclawConfigPath: path.join(rootDir, ".openclaw", "openclaw.json"),
      openclawSkillsDir: path.join(rootDir, ".openclaw", "skills"),
      openclawExtensionsDir: path.join(rootDir, ".openclaw", "extensions"),
      runtimePluginTemplatesDir: path.join(rootDir, "runtime-plugins"),
      openclawCuratedSkillsDir: path.join(
        rootDir,
        ".openclaw",
        "bundled-skills",
      ),
      openclawRuntimeModelStatePath: path.join(
        rootDir,
        ".openclaw",
        "nexu-runtime-model.json",
      ),
      skillhubCacheDir: path.join(rootDir, ".nexu", "skillhub-cache"),
      skillDbPath: path.join(rootDir, ".nexu", "skill-ledger.json"),
      staticSkillsDir: undefined,
      platformTemplatesDir: undefined,
      openclawWorkspaceTemplatesDir: path.join(
        rootDir,
        ".openclaw",
        "workspace-templates",
      ),
      openclawBin: "openclaw",
      litellmBaseUrl: null,
      litellmApiKey: null,
      openclawGatewayPort: 18789,
      openclawGatewayToken: undefined,
      manageOpenclawProcess: false,
      gatewayProbeEnabled: false,
      runtimeSyncIntervalMs: 2000,
      runtimeHealthIntervalMs: 5000,
      defaultModelId: "anthropic/claude-sonnet-4",
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("persists bot, channel, provider, and template state", async () => {
    const store = new NexuConfigStore(env);

    const bot = await store.createBot({ name: "Assistant", slug: "assistant" });
    const channel = await store.connectSlack({
      botToken: "xoxb-test",
      signingSecret: "secret",
      teamId: "T123",
      teamName: "Acme",
      appId: "A123",
    });
    const provider = await store.upsertProvider("openai", {
      apiKey: "sk-test",
      displayName: "OpenAI",
      modelsJson: JSON.stringify(["gpt-4o"]),
    });
    await store.upsertTemplate({ name: "AGENTS.md", content: "hello" });

    expect(bot.slug).toBe("assistant");
    expect(channel.accountId).toBe("slack-A123-T123");
    expect(provider.provider.hasApiKey).toBe(true);
    expect(await store.listTemplates()).toHaveLength(1);
    expect(await store.listProviders()).toHaveLength(1);
    expect(await store.listChannels()).toHaveLength(1);
  });

  it("keeps only the latest WeChat channel when reconnecting", async () => {
    const store = new NexuConfigStore(env);

    const slack = await store.connectSlack({
      botToken: "xoxb-test",
      signingSecret: "secret",
      teamId: "T123",
      teamName: "Acme",
      appId: "A123",
    });
    await store.connectWechat({ accountId: "old-wechat-account" });
    const latest = await store.connectWechat({
      accountId: "new-wechat-account",
    });

    const channels = await store.listChannels();

    expect(channels.map((channel) => channel.id)).toContain(slack.id);
    expect(
      channels
        .filter((channel) => channel.channelType === "wechat")
        .map((channel) => channel.accountId),
    ).toEqual([latest.accountId]);
  });

  it("reconciles legacy configs with multiple WeChat channels on startup", async () => {
    await mkdir(path.dirname(env.nexuConfigPath), { recursive: true });
    await writeFile(
      env.nexuConfigPath,
      JSON.stringify(
        {
          $schema: "https://api.clawpi.app:9443/config.json",
          schemaVersion: 1,
          app: {},
          bots: [
            {
              id: "bot-1",
              name: "Assistant",
              slug: "assistant",
              poolId: null,
              status: "active",
              modelId: env.defaultModelId,
              systemPrompt: null,
              createdAt: "2026-05-15T00:00:00.000Z",
              updatedAt: "2026-05-15T00:00:00.000Z",
            },
          ],
          runtime: {
            gateway: {
              port: env.openclawGatewayPort,
              bind: "loopback",
              authMode: "none",
            },
            defaultModelId: env.defaultModelId,
            defaultImageGenerationModelId: "",
          },
          providers: [],
          integrations: [],
          channels: [
            {
              id: "wechat-old",
              botId: "bot-1",
              channelType: "wechat",
              accountId: "old-wechat-account",
              status: "connected",
              teamName: null,
              appId: null,
              botUserId: null,
              createdAt: "2026-05-15T00:00:00.000Z",
              updatedAt: "2026-05-15T00:00:00.000Z",
            },
            {
              id: "wechat-new",
              botId: "bot-1",
              channelType: "wechat",
              accountId: "new-wechat-account",
              status: "connected",
              teamName: null,
              appId: null,
              botUserId: null,
              createdAt: "2026-05-15T00:01:00.000Z",
              updatedAt: "2026-05-15T00:01:00.000Z",
            },
          ],
          templates: {},
          desktop: {},
          secrets: {},
        },
        null,
        2,
      ),
    );

    const store = new NexuConfigStore(env);
    const result = await store.reconcileSingleWechatChannel();
    const channels = await store.listChannels();

    expect(result).toEqual({
      changed: true,
      keptAccountId: "new-wechat-account",
      removedCount: 1,
    });
    expect(channels.map((channel) => channel.accountId)).toEqual([
      "new-wechat-account",
    ]);
  });

  it("clears WeChat channels on startup while preserving other channels", async () => {
    const store = new NexuConfigStore(env);
    const slack = await store.connectSlack({
      botToken: "xoxb-test",
      signingSecret: "secret",
      teamId: "T123",
      teamName: "Acme",
      appId: "A123",
    });
    await store.connectWechat({ accountId: "wechat-account" });

    const result = await store.resetWechatChannelsForFreshLogin();
    const channels = await store.listChannels();

    expect(result).toEqual({ changed: true, removedCount: 1 });
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe(slack.id);
    expect(channels.some((channel) => channel.channelType === "wechat")).toBe(
      false,
    );
  });

  it("can mark a connected channel as errored", async () => {
    const store = new NexuConfigStore(env);

    const channel = await store.connectWechat({
      accountId: "expired-wechat-account",
    });
    const updated = await store.setChannelStatus(channel.id, "error");
    const channels = await store.listChannels();

    expect(updated?.status).toBe("error");
    expect(channels.find((entry) => entry.id === channel.id)?.status).toBe(
      "error",
    );
  });

  it("uses configured cloud endpoints for the default profile", async () => {
    const store = new NexuConfigStore(env);

    const status = await store.getDesktopCloudStatus();

    expect(status.activeProfileName).toBe("Default");
    expect(status.cloudUrl).toBe("https://nexu.io");
    expect(status.linkUrl).toBe("https://link.nexu.io");
    expect(status.profiles[0]).toMatchObject({
      name: "Default",
      cloudUrl: "https://nexu.io",
      linkUrl: "https://link.nexu.io",
    });
  });

  it("keeps the user's stored active default profile across package updates", async () => {
    await mkdir(env.nexuHomeDir, { recursive: true });
    await writeFile(
      path.join(env.nexuHomeDir, "cloud-profiles.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: [
          {
            name: "Default",
            cloudUrl: "http://47.108.215.151:9080",
            linkUrl: "https://yunwu.ai",
          },
        ],
      }),
      "utf8",
    );
    env.nexuCloudUrl = "https://expired-package.example.com";
    env.nexuLinkUrl = "https://expired-link.example.com";

    const store = new NexuConfigStore(env);
    const status = await store.getDesktopCloudStatus();

    expect(status.activeProfileName).toBe("Default");
    expect(status.cloudUrl).toBe("http://47.108.215.151:9080");
    expect(status.linkUrl).toBe("https://yunwu.ai");
  });

  it("preserves the stored default profile when importing custom profiles", async () => {
    await mkdir(env.nexuHomeDir, { recursive: true });
    await writeFile(
      path.join(env.nexuHomeDir, "cloud-profiles.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: [
          {
            name: "Default",
            cloudUrl: "http://47.108.215.151:9080",
            linkUrl: "https://yunwu.ai",
          },
        ],
      }),
      "utf8",
    );
    const store = new NexuConfigStore(env);

    const status = await store.setDesktopCloudProfiles([
      {
        name: "Staging",
        cloudUrl: "https://cloud.staging.example.com",
        linkUrl: "https://link.staging.example.com",
      },
    ]);

    expect(status.profiles[0]).toMatchObject({
      name: "Default",
      cloudUrl: "http://47.108.215.151:9080",
      linkUrl: "https://yunwu.ai",
    });
  });

  it("persists the built-in GPT-5.5 fallback for an authenticated empty catalog", async () => {
    const store = new NexuConfigStore(env);

    await store.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://link.nexu.io",
      apiKey: "link-key",
      models: [],
    });

    const status = await store.getDesktopCloudStatus();
    const config = await store.getConfig();

    expect(status.models).toContainEqual({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
    });
    expect(config.desktop.cloud?.models).toContainEqual({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
    });
  });

  it("refreshes connected desktop cloud models from curated models plus allowed authenticated supplements", async () => {
    const store = new NexuConfigStore(env);
    const requestedUrls: string[] = [];
    const authHeaders: Array<string | null> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        requestedUrls.push(url);
        const headers = new Headers(init?.headers);
        authHeaders.push(headers.get("authorization"));

        if (url === "https://yunwu.ai/v1/models") {
          return new Response(
            JSON.stringify({
              data: [
                { id: "gpt-5.5", name: "GPT-5.5", owned_by: "openai" },
                { id: "gpt-5.4", name: "GPT-5.4", owned_by: "openai" },
              ],
            }),
            { status: 200 },
          );
        }

        if (url === "https://nexu.io/v1/models") {
          return new Response(
            JSON.stringify({
              data: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            }),
            { status: 200 },
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    await store.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://yunwu.ai",
      apiKey: "link-key",
      models: [],
    });

    const status = await store.refreshDesktopCloudModels();

    expect(requestedUrls).toContain("https://yunwu.ai/v1/models");
    expect(requestedUrls).toContain("https://nexu.io/v1/models");
    expect(authHeaders).toContain("Bearer link-key");
    expect(authHeaders).toContain(null);
    expect(status.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.5",
    ]);
  });

  it("preserves an allowed supplemental default when authenticated model refresh is temporarily unavailable", async () => {
    env.defaultModelId = "link/gpt-5.4-mini";
    const store = new NexuConfigStore(env);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();

        if (url === "https://nexu.io/v1/models") {
          return new Response(
            JSON.stringify({
              data: [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini" }],
            }),
            { status: 200 },
          );
        }

        if (url === "https://yunwu.ai/v1/models") {
          return new Response("temporary gateway timeout", { status: 504 });
        }

        return new Response("not found", { status: 404 });
      }),
    );

    await store.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://yunwu.ai",
      apiKey: "link-key",
      models: [
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
        { id: "gpt-5.5", name: "GPT-5.5" },
      ],
    });
    await store.setDefaultModel("link/gpt-5.5");

    const status = await store.refreshDesktopCloudModels();
    const config = await store.getConfig();

    expect(status.models.map((model) => model.id)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.5",
    ]);
    expect(config.runtime.defaultModelId).toBe("link/gpt-5.5");
  });

  it("starts curated and authenticated model requests concurrently", async () => {
    const store = new NexuConfigStore(env);
    let resolveCurated: ((response: Response) => void) | undefined;
    let resolveAuthenticated: ((response: Response) => void) | undefined;
    const requestedUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = input.toString();
        requestedUrls.push(url);

        return new Promise<Response>((resolve) => {
          if (url === "https://nexu.io/v1/models") {
            resolveCurated = resolve;
            return;
          }
          if (url === "https://link.nexu.io/v1/models") {
            resolveAuthenticated = resolve;
            return;
          }
          resolve(new Response("not found", { status: 404 }));
        });
      }),
    );

    await store.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://link.nexu.io",
      apiKey: "link-key",
      models: [],
    });

    const refreshPromise = store.refreshDesktopCloudModels();

    await vi.waitFor(() => {
      expect(requestedUrls).toEqual(
        expect.arrayContaining([
          "https://nexu.io/v1/models",
          "https://link.nexu.io/v1/models",
        ]),
      );
    });
    expect(resolveCurated).toBeTypeOf("function");
    expect(resolveAuthenticated).toBeTypeOf("function");

    resolveCurated?.(
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-5.4", name: "GPT-5.4" }],
        }),
        { status: 200 },
      ),
    );
    resolveAuthenticated?.(
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        }),
        { status: 200 },
      ),
    );

    const status = await refreshPromise;
    expect(status.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.5",
    ]);
  });

  it("invalidates an expired cloud token while retaining the public catalog", async () => {
    const store = new NexuConfigStore(env);
    const expiredApiKey = "expired-link-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url === "https://nexu.io/v1/models") {
          return new Response(
            JSON.stringify({
              data: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            }),
            { status: 200 },
          );
        }
        if (url === "https://link.nexu.io/v1/models") {
          return new Response("This token has expired", { status: 401 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await store.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://link.nexu.io",
      apiKey: expiredApiKey,
      models: [
        { id: "gpt-5.4", name: "GPT-5.4" },
        { id: "gpt-5.5", name: "GPT-5.5" },
      ],
    });

    const status = await store.refreshDesktopCloudModels();
    const config = await store.getConfig();
    const cloud = (
      config.desktop as {
        cloud?: {
          apiKey?: string | null;
          invalidatedApiKeyHash?: string | null;
        };
      }
    ).cloud;

    expect(status.connected).toBe(false);
    expect(status.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
    expect(cloud?.apiKey).toBeNull();
    expect(cloud?.invalidatedApiKeyHash).toBeNull();

    await expect(
      store.importDesktopCloudStateIfNeeded({
        connected: true,
        polling: false,
        linkUrl: "https://link.nexu.io",
        apiKey: expiredApiKey,
        models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      }),
    ).resolves.toBe(false);
    await expect(store.getDesktopCloudStatus()).resolves.toMatchObject({
      connected: false,
      models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
    });

    const legacyConfig = await store.getConfig();
    const legacyDesktop = legacyConfig.desktop as {
      cloud?: Record<string, unknown>;
    };
    await writeFile(
      env.nexuConfigPath,
      JSON.stringify({
        ...legacyConfig,
        desktop: {
          ...legacyConfig.desktop,
          cloud: {
            ...legacyDesktop.cloud,
            invalidatedApiKeyHash: crypto
              .createHash("sha256")
              .update(expiredApiKey)
              .digest("hex"),
          },
        },
      }),
      "utf8",
    );

    const restartedStore = new NexuConfigStore(env);
    await expect(
      restartedStore.importDesktopCloudStateIfNeeded({
        connected: true,
        polling: false,
        linkUrl: "https://link.nexu.io",
        apiKey: expiredApiKey,
        models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      }),
    ).resolves.toBe(true);
    await expect(restartedStore.getDesktopCloudStatus()).resolves.toMatchObject(
      {
        connected: true,
        models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
      },
    );

    const restartedConfig = await restartedStore.getConfig();
    const restartedCloud = (
      restartedConfig.desktop as {
        cloud?: {
          apiKey?: string | null;
          invalidatedApiKeyHash?: string | null;
        };
      }
    ).cloud;
    expect(restartedCloud?.apiKey).toBe(expiredApiKey);
    expect(restartedCloud?.invalidatedApiKeyHash).toBeNull();
  });

  it("persists qqbot channels with app secrets in the secret store", async () => {
    const store = new NexuConfigStore(env);

    const channel = await store.connectQqbot({
      appId: "123456",
      appSecret: "qq-secret",
    });

    expect(channel.channelType).toBe("qqbot");
    expect(channel.accountId).toBe("qqbot-123456");
    expect(channel.appId).toBe("123456");
    expect(await store.getSecret(`channel:${channel.id}:appId`)).toBe("123456");
    expect(await store.getSecret(`channel:${channel.id}:clientSecret`)).toBe(
      "qq-secret",
    );
  });

  it("persists wecom channels with bot secrets in the secret store", async () => {
    const store = new NexuConfigStore(env);

    const channel = await store.connectWecom({
      botId: "wecom-bot-123",
      secret: "wecom-secret",
    });

    expect(channel.channelType).toBe("wecom");
    expect(channel.accountId).toBe("default");
    expect(channel.appId).toBe("wecom-bot-123");
    expect(await store.getSecret(`channel:${channel.id}:botId`)).toBe(
      "wecom-bot-123",
    );
    expect(await store.getSecret(`channel:${channel.id}:secret`)).toBe(
      "wecom-secret",
    );
  });

  it("clears an existing provider API key when null is explicitly provided", async () => {
    const store = new NexuConfigStore(env);

    await store.upsertProvider("openai", {
      apiKey: "sk-test",
      displayName: "OpenAI",
      modelsJson: JSON.stringify(["gpt-5.4"]),
    });

    const result = await store.upsertProvider("openai", {
      apiKey: null,
      modelsJson: JSON.stringify(["gpt-5.4"]),
    });

    expect(result.provider.hasApiKey).toBe(false);
    expect(result.provider.apiKey).toBeNull();
  });

  it("recovers from a broken primary config using backup-compatible data", async () => {
    const brokenConfigPath = env.nexuConfigPath;
    const backupPath = `${brokenConfigPath}.bak`;

    await mkdir(path.dirname(brokenConfigPath), { recursive: true });
    await writeFile(brokenConfigPath, "{not-json", "utf8");
    await writeFile(
      backupPath,
      JSON.stringify(
        {
          $schema: "https://nexu.io/config.json",
          bots: [],
          runtime: {},
          providers: [],
          integrations: [],
          channels: [],
          templates: {},
          desktop: {},
          secrets: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = new NexuConfigStore(env);
    const config = await store.getConfig();

    expect(config.schemaVersion).toBe(1);
    expect(config.$schema).toBe("https://nexu.io/config.json");
  });

  it("imports cloud profiles and switches active profile while clearing cloud auth", async () => {
    const store = new NexuConfigStore(env);

    await mkdir(path.dirname(env.nexuConfigPath), { recursive: true });
    await writeFile(
      env.nexuConfigPath,
      JSON.stringify(
        {
          $schema: "https://nexu.io/config.json",
          schemaVersion: 1,
          app: {},
          bots: [],
          runtime: {},
          providers: [],
          integrations: [],
          channels: [],
          templates: {},
          desktop: {
            localProfile: {
              id: "user-1",
              email: "user@nexu.io",
              name: "Cloud User",
              image: null,
              plan: "pro",
              inviteAccepted: true,
              onboardingCompleted: true,
              authSource: "cloud",
            },
            cloud: {
              connected: true,
              polling: false,
              userName: "Cloud User",
              userEmail: "user@nexu.io",
              connectedAt: "2026-03-23T00:00:00.000Z",
              linkUrl: "https://link.nexu.io",
              apiKey: "secret",
              models: [{ id: "m1", name: "Model 1" }],
            },
          },
          secrets: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    await store.setDesktopCloudProfiles([
      {
        name: "Local Dev",
        cloudUrl: "http://localhost:5173",
        linkUrl: "http://localhost:8080",
      },
    ]);

    const status = await store.switchDesktopCloudProfile("Local Dev");
    const config = await store.getConfig();

    expect(status.activeProfileName).toBe("Local Dev");
    expect(status.cloudUrl).toBe("http://localhost:5173");
    expect(status.linkUrl).toBe("http://localhost:8080");
    expect(status.connected).toBe(false);
    expect(status.models).toEqual([]);
    expect(status.profiles.map((profile) => profile.name)).toEqual([
      "Default",
      "Local Dev",
    ]);
    expect(
      (config.desktop as { localProfile?: { authSource?: string } })
        .localProfile?.authSource,
    ).toBe("desktop-local");
    expect(
      (config.desktop as { activeCloudProfileName?: string })
        .activeCloudProfileName,
    ).toBe("Local Dev");
  });

  it("updates and deletes custom cloud profiles", async () => {
    const store = new NexuConfigStore(env);

    await store.setDesktopCloudProfiles([
      {
        name: "Local Dev",
        cloudUrl: "http://localhost:5173",
        linkUrl: "http://localhost:8080",
      },
    ]);

    const updated = await store.updateDesktopCloudProfile("Local Dev", {
      name: "Local QA",
      cloudUrl: "http://127.0.0.1:5173",
      linkUrl: "http://127.0.0.1:8080",
    });

    expect(updated.profiles.map((profile) => profile.name)).toEqual([
      "Default",
      "Local QA",
    ]);

    const deleted = await store.deleteDesktopCloudProfile("Local QA");
    expect(deleted.profiles.map((profile) => profile.name)).toEqual([
      "Default",
    ]);
    expect(deleted.activeProfileName).toBe("Default");
  });

  it("creates a custom cloud profile", async () => {
    const store = new NexuConfigStore(env);

    const created = await store.createDesktopCloudProfile({
      name: "Staging",
      cloudUrl: "https://nexu.powerformer.net",
      linkUrl: "https://nexu.powerformer.net",
    });

    expect(created.profiles.map((profile) => profile.name)).toEqual([
      "Default",
      "Staging",
    ]);
  });
});
