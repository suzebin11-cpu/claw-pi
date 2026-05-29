import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { createApp } from "../src/app/create-app.js";
import type { ControllerEnv } from "../src/app/env.js";
import { OpenClawAuthProfilesStore } from "../src/runtime/openclaw-auth-profiles-store.js";
import { OpenClawAuthProfilesWriter } from "../src/runtime/openclaw-auth-profiles-writer.js";
import { OpenClawConfigWriter } from "../src/runtime/openclaw-config-writer.js";
import { OpenClawProcessManager } from "../src/runtime/openclaw-process.js";
import { OpenClawRuntimeModelWriter } from "../src/runtime/openclaw-runtime-model-writer.js";
import { OpenClawRuntimePluginWriter } from "../src/runtime/openclaw-runtime-plugin-writer.js";
import { OpenClawWatchTrigger } from "../src/runtime/openclaw-watch-trigger.js";
import { RuntimeHealth } from "../src/runtime/runtime-health.js";
import { SessionsRuntime } from "../src/runtime/sessions-runtime.js";
import { createRuntimeState } from "../src/runtime/state.js";
import { WorkspaceTemplateWriter } from "../src/runtime/workspace-template-writer.js";
import { AgentService } from "../src/services/agent-service.js";
import { ArtifactService } from "../src/services/artifact-service.js";
import { ChannelFallbackService } from "../src/services/channel-fallback-service.js";
import { ChannelService } from "../src/services/channel-service.js";
import { DesktopLocalService } from "../src/services/desktop-local-service.js";
import { IntegrationService } from "../src/services/integration-service.js";
import { LocalUserService } from "../src/services/local-user-service.js";
import { ModelProviderService } from "../src/services/model-provider-service.js";
import { OpenClawAuthService } from "../src/services/openclaw-auth-service.js";
import { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";
import { OpenClawSyncService } from "../src/services/openclaw-sync-service.js";
import { RuntimeConfigService } from "../src/services/runtime-config-service.js";
import { RuntimeModelStateService } from "../src/services/runtime-model-state-service.js";
import { SessionService } from "../src/services/session-service.js";
import type { SkillhubService } from "../src/services/skillhub-service.js";
import { TemplateService } from "../src/services/template-service.js";
import { ArtifactsStore } from "../src/store/artifacts-store.js";
import { CompiledOpenClawStore } from "../src/store/compiled-openclaw-store.js";
import { NexuConfigStore } from "../src/store/nexu-config-store.js";

async function createTestContainer(
  rootDir: string,
): Promise<ControllerContainer> {
  const env: ControllerEnv = {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuCloudUrl: "https://nexu.io",
    nexuLinkUrl: "https://link.nexu.io",
    nexuHomeDir: path.join(rootDir, ".nexu"),
    nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
    artifactsIndexPath: path.join(rootDir, ".nexu", "artifacts", "index.json"),
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
    openclawCuratedSkillsDir: path.join(rootDir, ".openclaw", "bundled-skills"),
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

  const configStore = new NexuConfigStore(env);
  const artifactsStore = new ArtifactsStore(env);
  const compiledStore = new CompiledOpenClawStore(env);
  const configWriter = new OpenClawConfigWriter(env);
  const authProfilesStore = new OpenClawAuthProfilesStore(env);
  const authProfilesWriter = new OpenClawAuthProfilesWriter(authProfilesStore);
  const runtimePluginWriter = new OpenClawRuntimePluginWriter(env);
  const runtimeModelWriter = new OpenClawRuntimeModelWriter(env);
  const templateWriter = new WorkspaceTemplateWriter(env);
  const watchTrigger = new OpenClawWatchTrigger(env);
  const sessionsRuntime = new SessionsRuntime(env);
  const runtimeHealth = new RuntimeHealth(env);
  const openclawProcess = new OpenClawProcessManager(env);
  const runtimeState = createRuntimeState();
  const wsClient = {
    isConnected: () => false,
    stop: vi.fn(),
  } as unknown as ControllerContainer["wsClient"];
  const gatewayService = new OpenClawGatewayService({
    isConnected: () => false,
    request: vi.fn(),
  } as never);
  const openclawSyncService = new OpenClawSyncService(
    env,
    configStore,
    compiledStore,
    configWriter,
    authProfilesWriter,
    authProfilesStore,
    runtimePluginWriter,
    runtimeModelWriter,
    templateWriter,
    watchTrigger,
    gatewayService,
  );
  const modelProviderService = new ModelProviderService(
    configStore,
    env.nodeEnv,
  );
  const runtimeModelStateService = new RuntimeModelStateService(env);
  const channelFallbackService = new ChannelFallbackService(
    openclawProcess,
    gatewayService,
    { getLocale: async () => "en" as const },
  );
  const skillhubService = {
    selectRelevantSkills: vi.fn(() => []),
    catalog: {
      getCatalog: () => ({
        skills: [],
        installedSlugs: [],
        installedSkills: [],
        meta: null,
      }),
      installSkill: vi.fn(async () => ({ ok: true })),
      uninstallSkill: vi.fn(async () => ({ ok: true })),
      refreshCatalog: vi.fn(async () => ({ ok: true, skillCount: 0 })),
      importSkillZip: vi.fn(async () => ({ ok: true })),
    },
    dispose: vi.fn(),
    start: vi.fn(),
  } as unknown as SkillhubService;
  const openclawAuthService = new OpenClawAuthService(env, authProfilesStore);

  return {
    env,
    configStore,
    gatewayClient: {
      fetchJson: vi.fn(),
    } as unknown as ControllerContainer["gatewayClient"],
    runtimeHealth,
    openclawProcess,
    agentService: new AgentService(configStore, openclawSyncService),
    channelService: new ChannelService(
      env,
      configStore,
      openclawSyncService,
      gatewayService,
      openclawProcess,
      runtimeHealth,
      wsClient,
    ),
    channelFallbackService,
    sessionService: new SessionService(sessionsRuntime),
    runtimeConfigService: new RuntimeConfigService(
      configStore,
      openclawSyncService,
    ),
    runtimeModelStateService,
    modelProviderService,
    integrationService: new IntegrationService(configStore),
    localUserService: new LocalUserService(configStore),
    desktopLocalService: new DesktopLocalService(
      configStore,
      modelProviderService,
      openclawProcess,
    ),
    artifactService: new ArtifactService(artifactsStore),
    templateService: new TemplateService(configStore, openclawSyncService),
    skillhubService,
    openclawSyncService,
    openclawAuthService,
    wsClient,
    gatewayService,
    runtimeState,
    startBackgroundLoops: () => () => {},
  };
}

describe("controller route compatibility", () => {
  let rootDir = "";
  let container: ControllerContainer;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-controller-routes-"));
    container = await createTestContainer(rootDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("serves local auth/user compatibility endpoints", async () => {
    const app = createApp(container);

    const meResponse = await app.request("/api/v1/me");
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as { email: string };
    expect(me.email).toBe("desktop@nexu.local");
  });

  it("supports channel connect, integration connect, session lifecycle, and runtime config routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("slack.com/api/auth.test")) {
          return new Response(
            JSON.stringify({
              ok: true,
              team_id: "T123",
              team: "Acme",
              bot_id: "B123",
            }),
            { status: 200 },
          );
        }
        if (url.includes("slack.com/api/bots.info")) {
          return new Response(
            JSON.stringify({ ok: true, bot: { app_id: "A123" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const app = createApp(container);

    const channelConnect = await app.request("/api/v1/channels/slack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botToken: "xoxb-test",
        signingSecret: "secret",
        teamId: "T123",
        appId: "A123",
      }),
    });
    expect(channelConnect.status).toBe(200);

    const integrationConnect = await app.request(
      "/api/v1/integrations/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolkitSlug: "openai",
          credentials: { apiKey: "sk-test" },
          source: "page",
        }),
      },
    );
    expect(integrationConnect.status).toBe(200);

    const createSession = await app.request("/api/internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "bot-1",
        sessionKey: "s1",
        title: "Session 1",
      }),
    });
    expect(createSession.status).toBe(201);

    const listSessions = await app.request("/api/v1/sessions?limit=10");
    expect(listSessions.status).toBe(200);
    const sessionList = (await listSessions.json()) as {
      total: number;
      sessions: Array<{ id: string }>;
    };
    expect(sessionList.total).toBe(1);

    const resetSession = await app.request(
      `/api/v1/sessions/${sessionList.sessions[0]?.id}/reset`,
      {
        method: "POST",
      },
    );
    expect(resetSession.status).toBe(200);

    const runtimeUpdate = await app.request("/api/v1/runtime-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gateway: { port: 18789, bind: "loopback", authMode: "none" },
        defaultModelId: "gpt-4o",
      }),
    });
    expect(runtimeUpdate.status).toBe(200);

    const importProfiles = await app.request(
      "/api/internal/desktop/cloud-profiles/import",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profiles: [
            {
              name: "Local Dev",
              cloudUrl: "http://localhost:5173",
              linkUrl: "http://localhost:8080",
            },
          ],
        }),
      },
    );
    expect(importProfiles.status).toBe(200);

    const switchProfile = await app.request(
      "/api/internal/desktop/cloud-profile/select",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Local Dev" }),
      },
    );
    expect(switchProfile.status).toBe(200);

    const createProfile = await app.request(
      "/api/internal/desktop/cloud-profile/create",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: {
            name: "Manual Staging",
            cloudUrl: "https://staging.example.com",
            linkUrl: "https://link.staging.example.com",
          },
        }),
      },
    );
    expect(createProfile.status).toBe(200);

    const updateProfile = await app.request(
      "/api/internal/desktop/cloud-profile/update",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previousName: "Local Dev",
          profile: {
            name: "Local QA",
            cloudUrl: "http://127.0.0.1:5173",
            linkUrl: "http://127.0.0.1:8080",
          },
        }),
      },
    );
    expect(updateProfile.status).toBe(200);

    const deleteProfile = await app.request(
      "/api/internal/desktop/cloud-profile/delete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Local QA" }),
      },
    );
    expect(deleteProfile.status).toBe(200);
  });

  it("supports qqbot connect when the plugin is installed", async () => {
    await mkdir(
      path.join(container.env.openclawExtensionsDir, "openclaw-qqbot"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "openclaw-qqbot",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "openclaw-qqbot", channels: ["qqbot"] }),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("bots.qq.com/app/getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "qq-access-token" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/qqbot/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: "123456",
        appSecret: "qq-secret",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      channelType: string;
      appId?: string;
    };
    expect(payload.channelType).toBe("qqbot");
    expect(payload.appId).toBe("123456");
  });

  it("injects dynamic skill context for explicit compat chat requests", async () => {
    await mkdir(path.dirname(container.env.openclawConfigPath), {
      recursive: true,
    });
    await writeFile(
      container.env.openclawConfigPath,
      JSON.stringify({
        gateway: {
          port: 18789,
          mode: "local",
          bind: "lan",
          auth: { mode: "none" },
          reload: { mode: "hybrid" },
        },
        models: {
          providers: {
            link: {
              baseUrl: "https://upstream.example/v1",
              apiKey: "test-key",
              api: "openai-completions",
              models: [{ id: "gpt-test" }],
            },
          },
        },
        agents: {
          defaults: { model: "link/gpt-test" },
          list: [{ id: "main", default: true, model: "link/gpt-test" }],
        },
        channels: {},
        bindings: [],
      }),
      "utf8",
    );

    const selectRelevantSkills = vi.fn(() => [
      {
        slug: "image-maker",
        source: "managed",
        agentId: null,
        name: "Image Maker",
        description: "Generate images",
        score: 8,
        content: "Use this skill when the user asks to generate images.",
        truncated: false,
      },
    ]);
    (
      container.skillhubService as unknown as {
        selectRelevantSkills: typeof selectRelevantSkills;
      }
    ).selectRelevantSkills = selectRelevantSkills;

    let upstreamPayload: {
      messages?: Array<{ role: string; content: string }>;
    } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "https://upstream.example/v1/chat/completions") {
          upstreamPayload = JSON.parse(
            String(init?.body ?? "{}"),
          ) as typeof upstreamPayload;
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const app = createApp(container);
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "帮我生成图片" }],
        stream: true,
        metadata: { clawpiDynamicSkills: true },
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(selectRelevantSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "帮我生成图片",
        agentId: "main",
        limit: 3,
      }),
    );
    expect(upstreamPayload?.messages?.[0]?.role).toBe("system");
    expect(upstreamPayload?.messages?.[0]?.content).toContain("Image Maker");
    expect(upstreamPayload?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: "帮我生成图片",
    });
  });

  it("rejects default model switches that OpenClaw cannot resolve", async () => {
    const app = createApp(container);

    const response = await app.request("/api/internal/desktop/default-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "link/gpt-5.5" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      modelId: string;
      error?: string;
    };
    expect(payload).toMatchObject({
      ok: false,
      modelId: "link/gpt-5.5",
    });
    expect(payload.error).toContain("模型服务尚未就绪");

    const config = await container.configStore.getConfig();
    expect(config.runtime.defaultModelId).not.toBe("link/gpt-5.5");
  });

  it("syncs default model switches into runtime state without rewriting OpenClaw config", async () => {
    await container.configStore.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://link.example.com",
      apiKey: "link-key",
      models: [
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ],
    });
    await container.configStore.setDefaultModel("link/gpt-5.4-mini");
    await container.openclawSyncService.syncAllImmediate();
    const openclawConfigBefore = await readFile(
      container.env.openclawConfigPath,
      "utf8",
    );
    const sessionsPath = path.join(
      container.env.openclawStateDir,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    await mkdir(path.dirname(sessionsPath), { recursive: true });
    await writeFile(
      sessionsPath,
      `${JSON.stringify(
        {
          "agent:main:direct:test": {
            sessionId: "session-1",
            updatedAt: 1,
            modelProvider: "link",
            model: "gpt-5.4-mini",
            contextTokens: 1000,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const app = createApp(container);

    const response = await app.request("/api/internal/desktop/default-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "link/gpt-5.5" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      modelId: "link/gpt-5.5",
    });

    const config = await container.configStore.getConfig();
    expect(config.runtime.defaultModelId).toBe("link/gpt-5.5");

    await expect(
      readFile(container.env.openclawConfigPath, "utf8"),
    ).resolves.toBe(openclawConfigBefore);

    const sessionStore = JSON.parse(
      await readFile(sessionsPath, "utf8"),
    ) as Record<
      string,
      {
        providerOverride?: string;
        modelOverride?: string;
        modelProvider?: string;
        model?: string;
        contextTokens?: number;
      }
    >;
    expect(sessionStore["agent:main:direct:test"]).toMatchObject({
      providerOverride: "link",
      modelOverride: "gpt-5.5",
    });
    expect(sessionStore["agent:main:direct:test"]?.modelProvider).toBe(
      undefined,
    );
    expect(sessionStore["agent:main:direct:test"]?.model).toBe(undefined);
    expect(sessionStore["agent:main:direct:test"]?.contextTokens).toBe(
      undefined,
    );

    const runtimeModelState = JSON.parse(
      await readFile(container.env.openclawRuntimeModelStatePath, "utf8"),
    ) as { selectedModelRef?: string };
    expect(runtimeModelState.selectedModelRef).toBe("link/gpt-5.5");
  });

  it("rejects image model switches until the Link provider is connected", async () => {
    const app = createApp(container);

    const response = await app.request(
      "/api/internal/desktop/default-image-model",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: "clawpi-image/gpt-image-1.5" }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      modelId: string;
      error?: string;
    };
    expect(payload).toMatchObject({
      ok: false,
      modelId: "clawpi-image/gpt-image-1.5",
    });
    expect(payload.error).toContain("生图模型需要先登录或刷新");

    const config = await container.configStore.getConfig();
    expect(config.runtime.defaultImageGenerationModelId).not.toBe(
      "clawpi-image/gpt-image-1.5",
    );
  });

  it("accepts image model switches after Link provider credentials exist", async () => {
    await container.configStore.applyActivationCloudState({
      connected: true,
      polling: false,
      linkUrl: "https://link.example.com",
      apiKey: "link-key",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    });
    const app = createApp(container);

    const response = await app.request(
      "/api/internal/desktop/default-image-model",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: "gpt-image-2" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      modelId: "clawpi-image/gpt-image-2",
    });

    const config = await container.configStore.getConfig();
    expect(config.runtime.defaultImageGenerationModelId).toBe(
      "clawpi-image/gpt-image-2",
    );
  });

  it("supports wecom connect when the plugin is installed", async () => {
    await mkdir(path.join(container.env.openclawExtensionsDir, "wecom"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "wecom",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "wecom", channels: ["wecom"] }),
      "utf8",
    );

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/wecom/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "wecom-bot-123",
        secret: "wecom-secret",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      channelType: string;
      appId?: string;
    };
    expect(payload.channelType).toBe("wecom");
    expect(payload.appId).toBe("wecom-bot-123");
  });

  it("supports wecom connectivity tests when the plugin is installed", async () => {
    await mkdir(path.join(container.env.openclawExtensionsDir, "wecom"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "wecom",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "wecom", channels: ["wecom"] }),
      "utf8",
    );

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/wecom/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "wecom-bot-123",
        secret: "wecom-secret",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.message).toContain("wecom-bot-123");
  });

  it("supports qqbot connectivity tests when the plugin is installed", async () => {
    await mkdir(
      path.join(container.env.openclawExtensionsDir, "openclaw-qqbot"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "openclaw-qqbot",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "openclaw-qqbot", channels: ["qqbot"] }),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("bots.qq.com/app/getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "qq-access-token" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/qqbot/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: "123456",
        appSecret: "qq-secret",
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.message).toContain("123456");
  });

  it("maps legacy qqbot account ids to the runtime default account for live status", async () => {
    const gatewayService = new OpenClawGatewayService(
      {
        isConnected: () => true,
        request: vi.fn(async () => ({
          channelOrder: ["qqbot"],
          channels: {},
          channelAccounts: {
            qqbot: [
              {
                accountId: "default",
                enabled: true,
                configured: true,
                running: true,
                connected: true,
                lastError: null,
              },
            ],
          },
        })),
      } as never,
      createRuntimeState(),
    );

    const result = await gatewayService.getAllChannelsLiveStatus([
      {
        id: "qq-channel-1",
        channelType: "qqbot",
        accountId: "qqbot-123456",
      },
    ]);

    expect(result.gatewayConnected).toBe(true);
    expect(result.channels).toEqual([
      {
        channelType: "qqbot",
        channelId: "qq-channel-1",
        accountId: "qqbot-123456",
        status: "connected",
        ready: true,
        connected: true,
        running: true,
        configured: true,
        lastError: null,
      },
    ]);
  });

  it("does not expose the removed internal skill compatibility endpoints", async () => {
    const app = createApp(container);

    const latestSkills = await app.request("/api/internal/skills/latest");
    expect(latestSkills.status).toBe(404);

    const skillUpsert = await app.request(
      "/api/internal/skills/daily-standup",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "# Standup" }),
      },
    );
    expect(skillUpsert.status).toBe(404);
  });

  it("serves workspace template internal compatibility endpoints", async () => {
    const app = createApp(container);

    const templateUpsert = await app.request(
      "/api/internal/workspace-templates/AGENTS.md",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      },
    );
    expect(templateUpsert.status).toBe(200);

    const latestTemplates = await app.request(
      "/api/internal/workspace-templates/latest",
    );
    expect(latestTemplates.status).toBe(200);
  });

  it("returns the default bot workspace path for desktop ready", async () => {
    const bot = await container.configStore.createBot({
      name: "nexu Assistant",
      slug: "nexu-assistant",
      modelId: "anthropic/claude-sonnet-4",
    });
    const app = createApp(container);

    const response = await app.request("/api/internal/desktop/ready");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      workspacePath: string;
      ready: boolean;
      desktopReady: boolean;
      webReady: boolean;
      openclawReady: boolean;
      agentReady: boolean;
      channelsReady: boolean;
      runtime: { ok: boolean; status: number | null; skipped?: boolean };
      blockers: Array<{ scope: string; code: string; message: string }>;
    };
    expect(payload.workspacePath).toBe(
      path.join(rootDir, ".openclaw", "agents", bot.id),
    );
    expect(payload.ready).toBe(true);
    expect(payload.desktopReady).toBe(true);
    expect(payload.webReady).toBe(true);
    expect(payload.openclawReady).toBe(false);
    expect(payload.agentReady).toBe(false);
    expect(payload.channelsReady).toBe(false);
    expect(payload.runtime).toMatchObject({ ok: false, skipped: true });
    expect(payload.blockers.map((blocker) => blocker.code)).toContain(
      "gateway_probe_disabled_no_ws",
    );
  });
});
