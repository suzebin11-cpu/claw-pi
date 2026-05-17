import type { OpenClawConfig } from "@nexu/shared";
import { openclawConfigSchema, selectPreferredModel } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import type { OAuthConnectionState } from "../runtime/openclaw-auth-profiles-store.js";
import type { NexuConfig } from "../store/schemas.js";
import { isSupportedByokProviderId } from "./byok-providers.js";
import {
  compileChannelBindings,
  compileChannelsConfig,
  resolveManagedChannelPluginId,
} from "./channel-binding-compiler.js";
import {
  type DesktopCloudModel,
  normalizeDesktopCloudModels,
} from "./desktop-cloud-models.js";
import { normalizeProviderBaseUrl } from "./provider-base-url.js";

export type { OAuthConnectionState };

const BYOK_DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://127.0.0.1:11434",
  siliconflow: "https://api.siliconflow.cn/v1",
  ppio: "https://api.ppinfra.com/v3/openai",
  openrouter: "https://openrouter.ai/api/v1",
  minimax: "https://api.minimax.io/anthropic",
  kimi: "https://api.moonshot.cn/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  moonshot: "https://api.moonshot.cn/v1",
  zai: "https://open.bigmodel.cn/api/paas/v4",
};

const LINK_PROVIDER_HEADERS = {
  "User-Agent": "Mozilla/5.0",
};

const EMPTY_OAUTH_CONNECTION_STATE: OAuthConnectionState = {
  connectedProviderIds: [],
};

const OAUTH_PROVIDER_MAP: Record<string, string> = {
  openai: "openai-codex",
};

const SILICONFLOW_OFFICIAL_API_BASE_URLS = [
  "https://api.siliconflow.cn/v1",
  "https://api.siliconflow.com/v1",
] as const;

function resolveByokDefaultBaseUrlAliases(input: {
  providerId: string;
  oauthRegion: "global" | "cn" | null;
}): string[] {
  if (resolveOpenClawProviderId(input.providerId) === "siliconflow") {
    return [...SILICONFLOW_OFFICIAL_API_BASE_URLS];
  }

  const defaultBaseUrl = resolveByokDefaultBaseUrl(input);
  return defaultBaseUrl ? [defaultBaseUrl] : [];
}

function resolveByokDefaultBaseUrl(input: {
  providerId: string;
  oauthRegion: "global" | "cn" | null;
}): string | undefined {
  const openclawProviderId = resolveOpenClawProviderId(input.providerId);

  if (openclawProviderId === "minimax" && input.oauthRegion === "cn") {
    return "https://api.minimaxi.com/anthropic";
  }

  return BYOK_DEFAULT_BASE_URLS[openclawProviderId];
}

function resolveOpenClawProviderId(providerId: string): string {
  switch (providerId) {
    case "kimi":
      return "moonshot";
    case "glm":
      return "zai";
    default:
      return providerId;
  }
}

function resolveOpenClawProviderApi(providerId: string): string {
  switch (resolveOpenClawProviderId(providerId)) {
    case "google":
      return "google-generative-ai";
    case "minimax":
      return "anthropic-messages";
    case "ollama":
      return "ollama";
    default:
      return "openai-completions";
  }
}

function resolveOpenClawProviderAuthHeader(
  providerId: string,
): boolean | undefined {
  return resolveOpenClawProviderId(providerId) === "minimax" ? true : undefined;
}

function isDesktopCloudConfig(value: unknown): value is {
  linkUrl: string;
  apiKey: string;
  models: Array<{ id: string; name: string; provider?: string }>;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.linkUrl === "string" &&
    typeof candidate.apiKey === "string" &&
    Array.isArray(candidate.models)
  );
}

function getDesktopCloudModelCatalog(
  config: NexuConfig,
): DesktopCloudModel[] | undefined {
  const cloud = config.desktop.cloud;
  if (typeof cloud !== "object" || cloud === null) {
    return undefined;
  }

  const models = (cloud as Record<string, unknown>).models;
  if (!Array.isArray(models)) {
    return undefined;
  }

  const catalog: DesktopCloudModel[] = [];
  for (const model of models) {
    if (typeof model !== "object" || model === null) {
      continue;
    }

    const candidate = model as Record<string, unknown>;
    if (typeof candidate.id !== "string") {
      continue;
    }
    if (typeof candidate.name !== "string") {
      continue;
    }

    catalog.push({
      id: candidate.id,
      name: candidate.name,
      provider:
        typeof candidate.provider === "string" ? candidate.provider : undefined,
    });
  }

  return catalog;
}

function getDesktopSelectedModel(config: NexuConfig): string | null {
  const selectedModelId = config.desktop.selectedModelId;
  return typeof selectedModelId === "string" && selectedModelId.length > 0
    ? selectedModelId
    : null;
}

function isByokProviderProxied(
  providerId: string,
  baseUrl: string | null,
  oauthRegion: "global" | "cn" | null,
): boolean {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return false;
  }

  const normalizedDefaultBaseUrls = new Set(
    resolveByokDefaultBaseUrlAliases({ providerId, oauthRegion })
      .map((value) => normalizeProviderBaseUrl(value))
      .filter((value): value is string => value !== null),
  );

  return (
    normalizedDefaultBaseUrls.size > 0 &&
    !normalizedDefaultBaseUrls.has(normalizedBaseUrl)
  );
}

function getByokProviderKey(input: {
  id: string;
  providerId: string;
  baseUrl: string | null;
  oauthRegion: "global" | "cn" | null;
}): string {
  const openclawProviderId = resolveOpenClawProviderId(input.providerId);
  return isByokProviderProxied(
    input.providerId,
    input.baseUrl,
    input.oauthRegion,
  )
    ? `byok_${openclawProviderId}`
    : openclawProviderId;
}

function getByokProviderModelId(
  providerKey: string,
  providerId: string,
  modelId: string,
): string {
  const openclawProviderId = resolveOpenClawProviderId(providerId);
  return providerKey === `byok_${openclawProviderId}`
    ? `${openclawProviderId}/${modelId}`
    : modelId;
}

function buildModelEntry(id: string, name?: string) {
  return {
    id,
    name: name ?? id,
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
    },
  };
}

function collectLitellmModelIds(config: NexuConfig): string[] {
  const selectedModelId = getDesktopSelectedModel(config);
  const candidateIds = [
    ...config.bots.map((bot) => bot.modelId),
    config.runtime.defaultModelId,
    selectedModelId,
  ];

  return [...new Set(candidateIds)]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .map((value) => value.replace(/^litellm\//, ""))
    .filter(
      (value) => !value.startsWith("link/") && !value.startsWith("debug/"),
    );
}

function compileModelsConfig(
  config: NexuConfig,
  env: ControllerEnv,
): OpenClawConfig["models"] {
  const providers: NonNullable<OpenClawConfig["models"]>["providers"] = {};

  if (env.litellmBaseUrl && env.litellmApiKey) {
    providers.litellm = {
      baseUrl: env.litellmBaseUrl,
      apiKey: env.litellmApiKey,
      api: "openai-completions",
      models: collectLitellmModelIds(config).map((modelId) =>
        buildModelEntry(modelId),
      ),
    };
  }

  for (const provider of config.providers.filter(
    (item) =>
      item.enabled &&
      (item.apiKey !== null || item.authMode === "oauth") &&
      isSupportedByokProviderId(item.providerId),
  )) {
    const providerKey = getByokProviderKey({
      id: provider.id,
      providerId: provider.providerId,
      baseUrl: provider.baseUrl,
      oauthRegion: provider.oauthRegion,
    });
    const baseUrl =
      normalizeProviderBaseUrl(
        provider.baseUrl ??
          resolveByokDefaultBaseUrl({
            providerId: provider.providerId,
            oauthRegion: provider.oauthRegion,
          }),
      ) ?? normalizeProviderBaseUrl(BYOK_DEFAULT_BASE_URLS.openai);

    if (baseUrl === null) {
      continue;
    }

    providers[providerKey] = {
      baseUrl,
      apiKey:
        provider.authMode === "oauth"
          ? (provider.oauthCredential?.access ?? "")
          : (provider.apiKey ?? ""),
      api: resolveOpenClawProviderApi(provider.providerId),
      ...(resolveOpenClawProviderAuthHeader(provider.providerId)
        ? { authHeader: true }
        : {}),
      models: provider.models.map((modelId) =>
        buildModelEntry(
          getByokProviderModelId(providerKey, provider.providerId, modelId),
          modelId,
        ),
      ),
    };
  }

  const desktopCloud = isDesktopCloudConfig(config.desktop.cloud)
    ? config.desktop.cloud
    : null;
  const desktopCloudModels = normalizeDesktopCloudModels(desktopCloud?.models);
  if (desktopCloud && desktopCloudModels.length > 0) {
    const linkBaseUrl =
      normalizeProviderBaseUrl(desktopCloud.linkUrl) ?? desktopCloud.linkUrl;

    providers.link = {
      baseUrl: `${linkBaseUrl}/v1`,
      apiKey: desktopCloud.apiKey,
      api: "openai-completions",
      headers: LINK_PROVIDER_HEADERS,
      models: desktopCloudModels.map((model) =>
        buildModelEntry(model.id, model.name),
      ),
    };
  }

  return Object.keys(providers).length > 0
    ? {
        mode: "replace",
        providers,
      }
    : undefined;
}

function compileModelAllowlist(
  modelsConfig: OpenClawConfig["models"],
  config: NexuConfig,
): Record<string, { alias: string }> | undefined {
  const allowlist: Record<string, { alias: string }> = {};

  if (modelsConfig?.providers) {
    for (const [providerKey, provider] of Object.entries(
      modelsConfig.providers,
    )) {
      for (const model of provider.models) {
        allowlist[`${providerKey}/${model.id}`] = {
          alias: model.name ?? model.id,
        };
      }
    }
  }

  for (const model of normalizeDesktopCloudModels(
    getDesktopCloudModelCatalog(config),
  )) {
    const modelRef = `link/${model.id}`;
    if (!allowlist[modelRef]) {
      allowlist[modelRef] = {
        alias: model.name ?? model.id,
      };
    }
  }

  return Object.keys(allowlist).length > 0 ? allowlist : undefined;
}

/**
 * Collect every model ref that the sidecar can actually resolve at runtime.
 *
 * The set is the union of:
 *   1. Every `${providerKey}/${modelId}` present in `compiled.models.providers`
 *      — these are the providers we explicitly write into openclaw.json.
 *   2. Every OAuth-mapped ref derived from `OAUTH_PROVIDER_MAP` for providers
 *      that are currently connected (e.g. `openai` with active credentials →
 *      `openai-codex/<modelId>`). These refs intentionally do NOT appear under
 *      `compiled.models.providers` because OAuth-managed providers are written
 *      via `auth-profiles.json` instead, but they are valid runtime targets
 *      and MUST be in the whitelist that `nexu-runtime-model.json` exposes —
 *      otherwise the runtime-model plugin will refuse to override and the
 *      agent silently falls back to the previous `agents.defaults.model`.
 */
export function collectAvailableRuntimeModelRefs(
  compiled: OpenClawConfig,
  config: NexuConfig,
  oauthState: OAuthConnectionState = EMPTY_OAUTH_CONNECTION_STATE,
): Array<{ id: string; name: string }> {
  const dedup = new Map<string, { id: string; name: string }>();

  const providers = compiled.models?.providers ?? {};
  for (const [providerKey, provider] of Object.entries(providers)) {
    for (const model of provider.models ?? []) {
      const id = `${providerKey}/${model.id}`;
      dedup.set(id, { id, name: model.name ?? model.id });
    }
  }

  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    const oauthTarget = OAUTH_PROVIDER_MAP[provider.providerId];
    if (!oauthTarget) continue;
    if (!oauthState.connectedProviderIds.includes(provider.providerId))
      continue;
    for (const modelId of provider.models) {
      const id = `${oauthTarget}/${modelId}`;
      if (!dedup.has(id)) {
        dedup.set(id, { id, name: modelId });
      }
    }
  }

  return [...dedup.values()];
}

function resolveAvailableRuntimeModel(
  desiredRef: string,
  availableRuntimeModels: Array<{ id: string; name: string }>,
): string {
  if (availableRuntimeModels.some((model) => model.id === desiredRef)) {
    return desiredRef;
  }

  return selectPreferredModel(availableRuntimeModels)?.id ?? desiredRef;
}

function resolveOpenClawDefaultModelRef(
  desiredRef: string,
  availableRuntimeModels: Array<{ id: string; name: string }>,
): string {
  if (
    desiredRef.startsWith("link/") &&
    !availableRuntimeModels.some((model) => model.id.startsWith("link/"))
  ) {
    const fallback = selectPreferredModel(
      availableRuntimeModels.filter((model) => !model.id.startsWith("link/")),
    );
    return fallback?.id ?? "debug/mock";
  }

  return resolveAvailableRuntimeModel(desiredRef, availableRuntimeModels);
}

function resolveGatewayAuthConfig(config: NexuConfig, env: ControllerEnv) {
  if (config.runtime.gateway.authMode !== "token") {
    return { mode: config.runtime.gateway.authMode };
  }

  if (!env.openclawGatewayToken) {
    return { mode: "none" as const };
  }

  return {
    mode: "token" as const,
    token: env.openclawGatewayToken,
  };
}

export function resolveModelId(
  config: NexuConfig,
  env: ControllerEnv,
  rawModelId: string,
  oauthState: OAuthConnectionState = EMPTY_OAUTH_CONNECTION_STATE,
): string {
  if (rawModelId.startsWith("litellm/") || rawModelId.startsWith("link/")) {
    return rawModelId;
  }

  const byokPrefixToKey = new Map<string, string>();
  const byokPrefixToProvider = new Map<string, string>();
  for (const provider of config.providers.filter((item) => item.enabled)) {
    if (!isSupportedByokProviderId(provider.providerId)) {
      continue;
    }

    const openclawProviderId = resolveOpenClawProviderId(provider.providerId);
    byokPrefixToKey.set(
      provider.providerId,
      getByokProviderKey({
        id: provider.id,
        providerId: provider.providerId,
        baseUrl: provider.baseUrl,
        oauthRegion: provider.oauthRegion,
      }),
    );
    byokPrefixToProvider.set(provider.providerId, openclawProviderId);
  }

  const slashIndex = rawModelId.indexOf("/");
  if (slashIndex > 0) {
    const prefix = rawModelId.slice(0, slashIndex);
    const modelSuffix = rawModelId.slice(slashIndex + 1);
    const byokKey = byokPrefixToKey.get(prefix);
    const openclawProviderId = byokPrefixToProvider.get(prefix);
    if (byokKey && openclawProviderId) {
      const oauthTarget = OAUTH_PROVIDER_MAP[prefix];
      if (oauthTarget) {
        const provider = config.providers.find(
          (item) => item.providerId === prefix,
        );
        if (
          provider?.enabled &&
          oauthState.connectedProviderIds.includes(prefix)
        ) {
          return `${oauthTarget}/${modelSuffix}`;
        }
      }

      const providerScopedModelId = `${openclawProviderId}/${modelSuffix}`;
      return byokKey === openclawProviderId
        ? providerScopedModelId
        : `${byokKey}/${providerScopedModelId}`;
    }
  }

  if (isDesktopCloudConfig(config.desktop.cloud)) {
    const cloudModels = config.desktop.cloud.models;
    const slashIndex = rawModelId.indexOf("/");
    const modelSuffix =
      slashIndex > 0 ? rawModelId.slice(slashIndex + 1) : null;
    // Only use Link fallback if the model actually exists in Link's model list
    if (cloudModels.some((m) => m.id === rawModelId)) {
      return `link/${rawModelId}`;
    }
    if (
      modelSuffix &&
      cloudModels.some((m) => m.id === modelSuffix || m.name === modelSuffix)
    ) {
      return `link/${modelSuffix}`;
    }
  }

  if (env.litellmBaseUrl && env.litellmApiKey) {
    return `litellm/${rawModelId}`;
  }

  return rawModelId;
}

function compileAgentList(
  config: NexuConfig,
  env: ControllerEnv,
  oauthState: OAuthConnectionState,
  defaultResolvedModelId: string,
  installedSkillSlugs?: readonly string[],
  workspaceSkillsByAgent?: ReadonlyMap<string, readonly string[]>,
): OpenClawConfig["agents"]["list"] {
  // Keep normal chat turns fast: globally installed skills can expand into a
  // very large skillsSnapshot in every session prompt. Workspace-scoped skills
  // still attach to the agent that owns that workspace, while global skills can
  // be re-enabled for diagnostics/power users with OPENCLAW_ENABLE_GLOBAL_SKILLS.
  const sharedSlugs =
    process.env.OPENCLAW_ENABLE_GLOBAL_SKILLS === "1"
      ? (installedSkillSlugs ?? [])
      : [];

  return config.bots
    .filter((bot) => bot.status === "active")
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((bot, index) => {
      const workspaceSlugs = workspaceSkillsByAgent?.get(bot.id) ?? [];
      const merged = [...new Set([...sharedSlugs, ...workspaceSlugs])];

      const botResolvedModelId = bot.modelId
        ? resolveModelId(config, env, bot.modelId, oauthState)
        : null;

      // Skip the per-agent `model` field when it would resolve to the
      // gateway-wide default. Without this normalization, every call to
      // `setDefaultModel` (which intentionally writes the new id to every
      // bot to keep the desktop "global model" UX consistent) bumps every
      // `agents.list[].model` entry, even though the effective model is
      // unchanged. That bump alters the openclaw.json hash on the next
      // syncAll() and forces the gateway to restart every channel monitor
      // — leaving Feishu / WeChat stuck in "数据同步中" for many seconds.
      const isExplicitOverride =
        botResolvedModelId !== null &&
        botResolvedModelId !== defaultResolvedModelId;

      return {
        id: bot.id,
        name: bot.name,
        workspace: `${env.openclawStateDir}/agents/${bot.id}`,
        default: index === 0,
        skills: merged,
        thinkingDefault: "off",
        reasoningDefault: "off",
        fastModeDefault: true,
        ...(isExplicitOverride
          ? { model: { primary: botResolvedModelId } }
          : {}),
      };
    });
}

function compilePlugins(
  config: NexuConfig,
  env: ControllerEnv,
): OpenClawConfig["plugins"] {
  const imageGenerationPluginId = "clawpi-image-generation";
  const hasMiniMaxOauth = config.providers.some(
    (provider) =>
      provider.providerId === "minimax" &&
      provider.enabled &&
      provider.authMode === "oauth" &&
      provider.oauthCredential !== null,
  );

  // Plugin entries are matched against sidecar reload rule
  // `{ prefix: "plugins", kind: "restart" }`. Any change to
  // `plugins.entries.*` — including a key being added / removed — forces a
  // full gateway restart (~20-45s) which tears down every channel.
  //
  // Therefore the set of `plugins.entries` we emit for channel plugins must
  // depend ONLY on whether the user has configured that channel type at
  // all, NOT on the channel's transient `status === "connected"`. With the
  // legacy "connected"-based filter, a network blip / OAuth token refresh
  // that flipped a Feishu channel from connected → disconnected would
  // remove the plugin entry, then re-adding the entry on recovery would
  // gateway-restart the whole sidecar (and along with it every other
  // channel). Keying on "configured" instead means the entry is stable
  // across the channel's normal up/down lifecycle.
  const configuredPluginIds = [
    ...new Set(
      config.channels
        .map((channel) => resolveManagedChannelPluginId(channel.channelType))
        .filter((pluginId): pluginId is string => pluginId !== null),
    ),
  ];

  // Channel-plugin loading must follow the user's actual configuration.
  // Loading `feishu` / `openclaw-weixin` whenever the desktop is alive (the
  // legacy unconditional `enabled: true`) causes the sidecar to keep the
  // weixin/feishu runtime initialized and re-trigger
  // `setWeixinRuntime` / register bursts every 3-5s for a channel the user
  // never set up. By gating on whether ANY channel of that type exists in
  // config (regardless of `connected` status), we still pre-warm the
  // plugin once the user adds their first account but stay completely
  // silent before that.
  const hasFeishuChannelConfigured = config.channels.some(
    (channel) => channel.channelType === "feishu",
  );
  const hasWechatChannelConfigured = config.channels.some(
    (channel) => channel.channelType === "wechat",
  );
  return {
    load: {
      paths: [env.openclawExtensionsDir],
    },
    ...(configuredPluginIds.length > 0
      ? {
          allow: [
            ...configuredPluginIds,
            "nexu-runtime-model",
            imageGenerationPluginId,
          ],
        }
      : {}),
    entries: {
      "memory-core": {
        enabled: true,
        config: {
          dreaming: {
            enabled: false,
          },
        },
      },
      feishu: {
        enabled: hasFeishuChannelConfigured,
      },
      "openclaw-weixin": {
        enabled: hasWechatChannelConfigured,
      },
      ...(configuredPluginIds.includes("dingtalk-connector")
        ? {
            "dingtalk-connector": {
              enabled: true,
            },
          }
        : {}),
      ...(configuredPluginIds.includes("wecom")
        ? {
            wecom: {
              enabled: true,
            },
          }
        : {}),
      ...(configuredPluginIds.includes("openclaw-qqbot")
        ? {
            "openclaw-qqbot": {
              enabled: true,
            },
          }
        : {}),
      "nexu-runtime-model": {
        enabled: true,
      },
      [imageGenerationPluginId]: {
        enabled: true,
        config: {
          controllerUrl: `http://127.0.0.1:${env.port}`,
        },
      },
      ...(hasMiniMaxOauth
        ? {
            "minimax-portal-auth": {
              enabled: true,
            },
          }
        : {}),
    },
  };
}

export function compileOpenClawConfig(
  config: NexuConfig,
  env: ControllerEnv,
  oauthState: OAuthConnectionState = EMPTY_OAUTH_CONNECTION_STATE,
  installedSkillSlugs?: readonly string[],
  workspaceSkillsByAgent?: ReadonlyMap<string, readonly string[]>,
): OpenClawConfig {
  const activeBots = config.bots.filter((bot) => bot.status === "active");
  const firstBotModel = activeBots[0]?.modelId ?? null;
  const defaultModelId = resolveModelId(
    config,
    env,
    firstBotModel ??
      getDesktopSelectedModel(config) ??
      config.runtime.defaultModelId,
    oauthState,
  );

  const modelsConfig = compileModelsConfig(config, env);
  const modelAllowlist = compileModelAllowlist(modelsConfig, config);
  const defaultModelRef = resolveOpenClawDefaultModelRef(
    defaultModelId,
    collectAvailableRuntimeModelRefs(
      { models: modelsConfig } as OpenClawConfig,
      config,
      oauthState,
    ),
  );

  const openClawConfig: OpenClawConfig = {
    gateway: {
      port: env.openclawGatewayPort,
      mode: "local",
      bind: config.runtime.gateway.bind,
      auth: resolveGatewayAuthConfig(config, env),
      reload: {
        mode: "hybrid",
      },
      controlUi: {
        allowedOrigins: [env.webUrl],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
      // Intentionally no tools allowlist: the Control UI is loopback-bound
      // and origin-restricted (only the user's own browser can reach it),
      // so the dashboard agent should have the same tool access as other
      // channels. A previous `allow: ["cron"]` whitelist silently blocked
      // exec/web/file tools, making the dashboard agent unable to write
      // files or run shell commands while the same agent worked correctly
      // over Feishu/WeChat channels.
    },
    agents: {
      defaults: {
        model: { primary: defaultModelRef },
        ...(modelAllowlist ? { models: modelAllowlist } : {}),
        // Raise the default LLM idle timeout from the sidecar default of 60s
        // to 180s. Slow first-token paths (large skill prompts, cloud
        // failover, BYOK retry, dictionary skills warming) routinely
        // exceed 60s on cold start and trip OpenClaw's "Profile timed
        // out. Trying next account..." abort, which surfaces to the user
        // as "消息发了不回". 180s still bounds the request in case the
        // upstream truly hangs, but lets a single slow turn complete
        // before we kill it.
        llm: {
          idleTimeoutSeconds: 180,
        },
        thinkingDefault: "off",
        contextInjection: "continuation-skip",
        bootstrapMaxChars: 3500,
        bootstrapTotalMaxChars: 12000,
        bootstrapPromptTruncationWarning: "off",
        compaction: {
          mode: "safeguard",
          maxHistoryShare: 0.5,
          keepRecentTokens: 20000,
          recentTurnsPreserve: 5,
          qualityGuard: { enabled: true },
          memoryFlush: {
            enabled: true,
          },
        },
        humanDelay: {
          mode: "off",
        },
        verboseDefault: "off",
        elevatedDefault: "full",
      },
      list: compileAgentList(
        config,
        env,
        oauthState,
        defaultModelRef,
        installedSkillSlugs,
        workspaceSkillsByAgent,
      ),
    },
    tools: {
      exec: {
        security: "full",
        ask: "off",
        host: process.env.SANDBOX_ENABLED === "true" ? "sandbox" : "gateway",
      },
      web: {
        search: {
          enabled: true,
          ...(process.env.BRAVE_API_KEY
            ? { provider: "brave", apiKey: process.env.BRAVE_API_KEY }
            : {}),
        },
        fetch: {
          enabled: true,
        },
      },
      ...(process.env.SANDBOX_ENABLED === "true"
        ? {
            sandbox: {
              tools: {
                allow: [],
                deny: ["gateway"],
              },
            },
          }
        : {}),
    },
    session: {
      dmScope: "per-peer",
      // Disable automatic session reset. OpenClaw defaults to daily reset at
      // 4 AM which silently drops conversation history — unexpected for a
      // desktop chat app where users expect persistent sessions.
      reset: {
        mode: "idle",
        idleMinutes: 525_600, // 1 year
      },
    },
    cron: {
      enabled: true,
    },
    messages: {
      ackReaction: "eyes",
      ackReactionScope: "group-mentions",
      removeAckAfterReply: true,
    },
    models: modelsConfig,
    channels: compileChannelsConfig({
      channels: config.channels,
      secrets: config.secrets,
      controllerBaseUrl: `http://127.0.0.1:${env.port}`,
    }),
    bindings: compileChannelBindings(config.bots, config.channels),
    plugins: compilePlugins(config, env),
    skills: {
      load: {
        watch: true,
        watchDebounceMs: 250,
        extraDirs: [env.openclawSkillsDir, env.userSkillsDir].filter(Boolean),
      },
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
      ownerDisplay: "raw",
      ownerAllowFrom: ["*"],
    },
    diagnostics: {
      enabled: true,
      ...(process.env.DD_API_KEY || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? {
            otel: {
              enabled: true,
              endpoint:
                process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
                `https://otlp.${process.env.DD_SITE ?? "datadoghq.com"}`,
              serviceName: process.env.OTEL_SERVICE_NAME ?? "nexu-openclaw",
              traces: true,
              metrics: true,
              logs: true,
              ...(process.env.DD_API_KEY
                ? {
                    headers: {
                      "dd-api-key": process.env.DD_API_KEY,
                    },
                  }
                : {}),
            },
          }
        : {}),
    },
  };

  return openclawConfigSchema.parse(openClawConfig);
}
