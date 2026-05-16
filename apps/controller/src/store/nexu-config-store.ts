import crypto from "node:crypto";
import path from "node:path";
import type {
  BotResponse,
  ChannelResponse,
  ConnectDingtalkInput,
  ConnectDiscordInput,
  ConnectFeishuInput,
  ConnectQqbotInput,
  ConnectSlackInput,
  ConnectWecomInput,
} from "@nexu/shared";
import {
  type cloudProfileSchema,
  type connectIntegrationResponseSchema,
  type connectIntegrationSchema,
  type integrationResponseSchema,
  type providerResponseSchema,
  type refreshIntegrationSchema,
  type updateAuthSourceSchema,
  type updateUserProfileSchema,
  type upsertProviderBodySchema,
  userProfileResponseSchema,
} from "@nexu/shared";
import type { z } from "zod";
import type { ControllerEnv } from "../app/env.js";
import {
  DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID,
  normalizeDesktopCloudImageModelId,
  normalizeDesktopCloudModels,
} from "../lib/desktop-cloud-models.js";
import { logger } from "../lib/logger.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import { LowDbStore } from "./lowdb-store.js";
import {
  type CloudProfileEntry,
  type CloudProfilesFile,
  type ControllerProvider,
  type ControllerRuntimeConfig,
  type NexuConfig,
  cloudProfilesFileSchema,
  nexuConfigSchema,
  type storedProviderResponseSchema,
} from "./schemas.js";

type ProviderResponse = z.infer<typeof providerResponseSchema>;
type UpsertProviderBody = z.infer<typeof upsertProviderBodySchema>;
type IntegrationResponse = z.infer<typeof integrationResponseSchema>;
type StoredProviderResponse = z.infer<typeof storedProviderResponseSchema>;
type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
type ConnectIntegrationResponse = z.infer<
  typeof connectIntegrationResponseSchema
>;
type RefreshIntegrationInput = z.infer<typeof refreshIntegrationSchema>;
type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;
type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
type UpdateAuthSourceInput = z.infer<typeof updateAuthSourceSchema>;
type CloudProfileInput = z.infer<typeof cloudProfileSchema>;

type CloudModel = { id: string; name: string; provider?: string };
type DesktopCloudState = {
  connected: boolean;
  polling: boolean;
  userName?: string | null;
  userEmail?: string | null;
  connectedAt?: string | null;
  linkUrl?: string | null;
  apiKey?: string | null;
  models?: Array<{ id: string; name: string; provider?: string }>;
  cacheKey?: string | null;
  modelsUpdatedAt?: number | null;
};

type CloudPollingState = {
  deviceId: string;
  deviceSecret: string;
  abortController: AbortController;
};

type ActivationState = {
  activated: boolean;
  email: string | null;
  jwt: string | null;
  apiKey: string | null;
  activatedAt: string | null;
  codePrefix: string | null;
};

const DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID = "default";
const DESKTOP_CLOUD_SUPPLEMENTAL_MODEL_IDS = new Set(["gpt-5.5"]);

function pickSupplementalDesktopCloudModels(
  models: readonly CloudModel[] | null | undefined,
): CloudModel[] {
  return normalizeDesktopCloudModels(
    (models ?? []).filter((model) =>
      DESKTOP_CLOUD_SUPPLEMENTAL_MODEL_IDS.has(model.id),
    ),
  );
}

function mergeDesktopCloudModelCatalogs(input: {
  curatedModels: readonly CloudModel[];
  supplementalModels: readonly CloudModel[] | null | undefined;
}): CloudModel[] {
  return normalizeDesktopCloudModels([
    ...input.curatedModels,
    ...pickSupplementalDesktopCloudModels(input.supplementalModels),
  ]);
}

const defaultCloudProfile: CloudProfileEntry = {
  name: "Default",
  cloudUrl: "http://47.108.215.151:9080",
  linkUrl: "https://yunwu.ai",
};

const CLOUD_BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAST_DEFAULT_MIGRATION_KEY = "fastDefaultModelMigrationV1";
function buildDesktopCloudCacheKey(profile: CloudProfileEntry): string {
  return [profile.name.trim(), profile.cloudUrl.trim(), profile.linkUrl.trim()]
    .join("::")
    .toLowerCase();
}

export type DesktopCloudStateChange = {
  hadCloudInventory: boolean;
  hasCloudInventory: boolean;
  connected: boolean;
};

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  const cause = error.cause;

  if (cause && typeof cause === "object") {
    const code = "code" in cause ? cause.code : undefined;
    const message = "message" in cause ? cause.message : undefined;

    if (typeof code === "string" && code.length > 0) {
      parts.push(code);
    }

    if (typeof message === "string" && message.length > 0) {
      parts.push(message);
    }
  }

  return parts.join(" | ");
}

function buildLinkModelsUrl(baseUrl: string): string {
  return new URL(
    "v1/models",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

type CloudPollResponse = {
  status: string;
  apiKey?: string;
  userName?: string;
  userEmail?: string;
  cloudModels?: CloudModel[];
  linkGatewayUrl?: string;
};

function defaultLocalProfile(): UserProfileResponse {
  return {
    id: "desktop-local-user",
    email: "desktop@nexu.local",
    name: "Desktop User",
    image: null,
    plan: "local",
    inviteAccepted: true,
    onboardingCompleted: true,
    authSource: "desktop-local",
  };
}

function readLocalProfile(config: NexuConfig): UserProfileResponse {
  const desktop = config.desktop as Record<string, unknown>;
  const parsed = userProfileResponseSchema.safeParse(desktop.localProfile);
  return parsed.success ? parsed.data : defaultLocalProfile();
}

function normalizeDesktopCloudState(
  cloud: Record<string, unknown> | null,
): DesktopCloudState {
  return {
    connected: cloud?.connected === true,
    polling: cloud?.polling === true,
    userName: typeof cloud?.userName === "string" ? cloud.userName : null,
    userEmail: typeof cloud?.userEmail === "string" ? cloud.userEmail : null,
    connectedAt:
      typeof cloud?.connectedAt === "string" ? cloud.connectedAt : null,
    linkUrl: typeof cloud?.linkUrl === "string" ? cloud.linkUrl : undefined,
    apiKey: typeof cloud?.apiKey === "string" ? cloud.apiKey : undefined,
    models: Array.isArray(cloud?.models)
      ? (cloud.models as Array<{ id: string; name: string; provider?: string }>)
      : [],
    cacheKey: typeof cloud?.cacheKey === "string" ? cloud.cacheKey : null,
    modelsUpdatedAt:
      typeof cloud?.modelsUpdatedAt === "number" &&
      Number.isFinite(cloud.modelsUpdatedAt)
        ? cloud.modelsUpdatedAt
        : null,
  };
}

function readDesktopCloud(config: NexuConfig): DesktopCloudState {
  const desktop = config.desktop as Record<string, unknown>;
  const cloud =
    typeof desktop.cloud === "object" && desktop.cloud !== null
      ? (desktop.cloud as Record<string, unknown>)
      : null;

  return normalizeDesktopCloudState(cloud);
}

function readDesktopCloudSessions(
  config: NexuConfig,
): Record<string, DesktopCloudState> {
  const desktop = config.desktop as Record<string, unknown>;
  const sessions =
    typeof desktop.cloudSessions === "object" && desktop.cloudSessions !== null
      ? (desktop.cloudSessions as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    Object.entries(sessions).map(([name, value]) => [
      name,
      normalizeDesktopCloudState(
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : null,
      ),
    ]),
  );
}

function readDesktopActivation(config: NexuConfig): ActivationState {
  const desktop = config.desktop as Record<string, unknown>;
  const activation =
    typeof desktop.activation === "object" && desktop.activation !== null
      ? (desktop.activation as Record<string, unknown>)
      : null;

  return {
    activated: activation?.activated === true,
    email: typeof activation?.email === "string" ? activation.email : null,
    jwt: typeof activation?.jwt === "string" ? activation.jwt : null,
    apiKey: typeof activation?.apiKey === "string" ? activation.apiKey : null,
    activatedAt:
      typeof activation?.activatedAt === "string"
        ? activation.activatedAt
        : null,
    codePrefix:
      typeof activation?.codePrefix === "string" ? activation.codePrefix : null,
  };
}

function readDesktopLocale(config: NexuConfig): "en" | "zh-CN" | null {
  const desktop = config.desktop as Record<string, unknown>;
  if (desktop.locale === "zh-CN") {
    return "zh-CN";
  }
  if (desktop.locale === "en") {
    return "en";
  }
  return null;
}

function readDesktopActiveCloudProfileName(config: NexuConfig): string | null {
  const desktop = config.desktop as Record<string, unknown>;
  return typeof desktop.activeCloudProfileName === "string"
    ? desktop.activeCloudProfileName
    : null;
}

function normalizeImportedCloudProfiles(
  profiles: CloudProfileInput[],
): CloudProfileEntry[] {
  const deduped = new Map<string, CloudProfileEntry>();

  for (const profile of profiles) {
    const name = profile.name.trim();
    if (name.length === 0 || name === defaultCloudProfile.name) {
      continue;
    }

    deduped.set(name, {
      name,
      cloudUrl: profile.cloudUrl.trim(),
      linkUrl: profile.linkUrl.trim(),
    });
  }

  return [defaultCloudProfile, ...Array.from(deduped.values())];
}

function isDefaultCloudProfileName(name: string): boolean {
  return name.trim() === defaultCloudProfile.name;
}

function now(): string {
  return new Date().toISOString();
}

function parseModelsJson(modelsJson: string | undefined): string[] {
  if (!modelsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(modelsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function serializeProvider(
  provider: ControllerProvider,
): StoredProviderResponse {
  return {
    id: provider.id,
    providerId: provider.providerId,
    displayName: provider.displayName,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    authMode: provider.authMode,
    hasApiKey: provider.apiKey !== null,
    hasOauthCredential: provider.oauthCredential !== null,
    oauthRegion: provider.oauthRegion,
    oauthEmail: provider.oauthCredential?.email ?? null,
    modelsJson: JSON.stringify(provider.models),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    apiKey: provider.apiKey,
    models: provider.models,
  };
}

export class NexuConfigStore {
  private readonly store: LowDbStore<NexuConfig>;
  private readonly cloudProfilesStore: LowDbStore<CloudProfilesFile>;
  private readonly env: ControllerEnv;
  private pollingState: CloudPollingState | null = null;

  /** Callback fired when cloud state changes (connect/disconnect). */
  onCloudStateChanged?: (change: DesktopCloudStateChange) => Promise<void>;

  constructor(env: ControllerEnv) {
    this.env = env;
    this.store = new LowDbStore<NexuConfig>(
      env.nexuConfigPath,
      nexuConfigSchema,
      () => ({
        $schema: "https://api.clawpi.app:9443/config.json",
        schemaVersion: 1,
        app: {},
        bots: [],
        runtime: {
          gateway: {
            port: env.openclawGatewayPort,
            bind: "loopback",
            authMode: env.openclawGatewayToken ? "token" : "none",
          },
          defaultModelId: env.defaultModelId,
          defaultImageGenerationModelId: DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID,
        },
        providers: [],
        integrations: [],
        channels: [],
        templates: {},
        desktop: {},
        secrets: {},
      }),
    );
    this.cloudProfilesStore = new LowDbStore<CloudProfilesFile>(
      path.join(env.nexuHomeDir, "cloud-profiles.json"),
      cloudProfilesFileSchema,
      () => ({
        schemaVersion: 1,
        profiles: [defaultCloudProfile],
      }),
    );
  }

  async getConfig(): Promise<NexuConfig> {
    return this.store.read();
  }

  private async listStoredCloudProfiles(): Promise<CloudProfileEntry[]> {
    const file = await this.cloudProfilesStore.read();
    return normalizeImportedCloudProfiles(file.profiles);
  }

  private resolveActiveCloudProfile(
    profiles: CloudProfileEntry[],
    activeProfileName: string | null,
  ): CloudProfileEntry {
    return (
      profiles.find((profile) => profile.name === activeProfileName) ??
      profiles.find((profile) => profile.name === defaultCloudProfile.name) ??
      defaultCloudProfile
    );
  }

  private async readConfiguredDesktopCloudProfile(config: NexuConfig) {
    const profiles = await this.listStoredCloudProfiles();
    const activeProfileName = readDesktopActiveCloudProfileName(config);
    const activeProfile = this.resolveActiveCloudProfile(
      profiles,
      activeProfileName,
    );
    return { profiles, activeProfile };
  }

  private async writeActiveDesktopCloudState(
    input: DesktopCloudState,
  ): Promise<void> {
    await this.store.update((config) => {
      const activeProfileName =
        readDesktopActiveCloudProfileName(config) ?? defaultCloudProfile.name;
      const sessions = readDesktopCloudSessions(config);
      const currentCloud = readDesktopCloud(config);
      const rawNextModels = input.models ?? currentCloud.models ?? [];
      const shouldIncludeBuiltInModels =
        rawNextModels.length > 0 || input.apiKey != null;
      const nextModels = shouldIncludeBuiltInModels
        ? normalizeDesktopCloudModels(rawNextModels)
        : rawNextModels;
      const hasModels = nextModels.length > 0;
      const nextCacheKey = hasModels
        ? (input.cacheKey ?? currentCloud.cacheKey ?? null)
        : null;
      const nextModelsUpdatedAt = hasModels
        ? (input.modelsUpdatedAt ?? currentCloud.modelsUpdatedAt ?? null)
        : null;

      return {
        ...config,
        desktop: {
          ...config.desktop,
          cloud: {
            connected: input.connected,
            polling: input.polling,
            userName: input.userName ?? null,
            userEmail: input.userEmail ?? null,
            connectedAt: input.connectedAt ?? null,
            linkUrl: input.linkUrl ?? null,
            apiKey: input.apiKey ?? null,
            models: nextModels,
            cacheKey: nextCacheKey,
            modelsUpdatedAt: nextModelsUpdatedAt,
          },
          cloudSessions: {
            ...sessions,
            [activeProfileName]: {
              connected: input.connected,
              polling: input.polling,
              userName: input.userName ?? null,
              userEmail: input.userEmail ?? null,
              connectedAt: input.connectedAt ?? null,
              linkUrl: input.linkUrl ?? null,
              apiKey: input.apiKey ?? null,
              models: nextModels,
              cacheKey: nextCacheKey,
              modelsUpdatedAt: nextModelsUpdatedAt,
            },
          },
        },
      };
    });
  }

  private async resolveDesktopCloudLinkUrl(
    config: NexuConfig,
    linkUrl?: string | null,
  ): Promise<string> {
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    return linkUrl ?? activeProfile.linkUrl ?? activeProfile.cloudUrl;
  }

  async reconcileConfiguredDesktopCloudState(): Promise<void> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);

    if (!cloud.connected) {
      return;
    }

    const linkUrl = await this.resolveDesktopCloudLinkUrl(
      config,
      cloud.linkUrl,
    );
    if (cloud.linkUrl === linkUrl) {
      return;
    }

    const endpointChanged = cloud.linkUrl !== linkUrl;

    await this.setDesktopCloudState({
      connected: endpointChanged ? false : cloud.connected,
      polling: false,
      userName: endpointChanged ? null : (cloud.userName ?? null),
      userEmail: endpointChanged ? null : (cloud.userEmail ?? null),
      connectedAt: endpointChanged ? null : (cloud.connectedAt ?? null),
      linkUrl,
      apiKey: endpointChanged ? null : (cloud.apiKey ?? null),
      models: endpointChanged ? [] : (cloud.models ?? []),
    });
  }

  private async setDesktopCloudState(input: {
    connected: boolean;
    polling: boolean;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    linkUrl?: string | null;
    apiKey?: string | null;
    models?: CloudModel[];
    cacheKey?: string | null;
    modelsUpdatedAt?: number | null;
  }): Promise<void> {
    await this.writeActiveDesktopCloudState(input);
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  }

  private async pollDesktopCloudAuthorization(
    cloudApiUrl: string,
    deviceId: string,
    deviceSecret: string,
    signal: AbortSignal,
  ): Promise<void> {
    const maxAttempts = 100;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.sleep(3000, signal);
      } catch {
        return;
      }

      if (signal.aborted) {
        return;
      }

      try {
        const res = await proxyFetch(`${cloudApiUrl}/api/auth/device-poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId, deviceSecret }),
          signal,
        });

        if (!res.ok) {
          continue;
        }

        const data = (await res.json()) as CloudPollResponse;

        if (data.status === "completed" && data.apiKey) {
          const currentConfig = await this.getConfig();
          const previousCloud = readDesktopCloud(currentConfig);
          const { activeProfile } =
            await this.readConfiguredDesktopCloudProfile(currentConfig);
          const cacheKey = buildDesktopCloudCacheKey(activeProfile);
          const linkUrl = await this.resolveDesktopCloudLinkUrl(
            currentConfig,
            data.linkGatewayUrl,
          );
          const curatedModels = await this.fetchDesktopCloudModels(
            buildLinkModelsUrl(activeProfile.cloudUrl),
          );
          const supplementalModels = await this.fetchDesktopCloudModels(
            buildLinkModelsUrl(linkUrl),
            data.apiKey,
          );
          const models =
            curatedModels && curatedModels.length > 0
              ? mergeDesktopCloudModelCatalogs({
                  curatedModels,
                  supplementalModels:
                    supplementalModels ?? data.cloudModels ?? null,
                })
              : pickSupplementalDesktopCloudModels(
                  supplementalModels ?? data.cloudModels ?? [],
                );

          this.pollingState = null;
          await this.setDesktopCloudState({
            connected: true,
            polling: false,
            userName: data.userName ?? null,
            userEmail: data.userEmail ?? null,
            connectedAt: now(),
            linkUrl,
            apiKey: data.apiKey,
            models,
            cacheKey,
            modelsUpdatedAt: models.length > 0 ? Date.now() : null,
          });
          await this.onCloudStateChanged?.({
            hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
            hasCloudInventory: models.length > 0,
            connected: true,
          });
          return;
        }

        if (data.status === "expired") {
          this.pollingState = null;
          await this.setDesktopCloudState({
            connected: false,
            polling: false,
            userName: null,
            userEmail: null,
            connectedAt: null,
            linkUrl: null,
            apiKey: null,
            models: [],
          });
          return;
        }
      } catch {
        if (signal.aborted) {
          return;
        }
      }
    }

    this.pollingState = null;
    await this.setDesktopCloudState({
      connected: false,
      polling: false,
      userName: null,
      userEmail: null,
      connectedAt: null,
      linkUrl: null,
      apiKey: null,
      models: [],
    });
  }

  async listBots(): Promise<BotResponse[]> {
    const config = await this.getConfig();
    return config.bots;
  }

  async getBot(botId: string): Promise<BotResponse | null> {
    const config = await this.getConfig();
    return config.bots.find((bot) => bot.id === botId) ?? null;
  }

  async getOrCreateDefaultBot(): Promise<BotResponse> {
    const existing = await this.listBots();
    if (existing.length > 0) {
      const firstBot = existing[0];
      if (firstBot) {
        return firstBot;
      }
    }

    const config = await this.getConfig();
    return this.createBot({
      name: "Claw-Pi Assistant",
      slug: "claw-pi-assistant",
      modelId: config.runtime.defaultModelId,
    });
  }

  async createBot(input: {
    name: string;
    slug: string;
    systemPrompt?: string;
    modelId?: string;
    poolId?: string;
  }): Promise<BotResponse> {
    const createdAt = now();
    const bot: BotResponse = {
      id: crypto.randomUUID(),
      name: input.name,
      slug: input.slug,
      poolId: input.poolId ?? null,
      status: "active",
      modelId: input.modelId ?? (await this.getConfig()).runtime.defaultModelId,
      systemPrompt: input.systemPrompt ?? null,
      createdAt,
      updatedAt: createdAt,
    };

    await this.store.update((config) => ({
      ...config,
      bots: [...config.bots, bot],
    }));

    return bot;
  }

  async updateBot(
    botId: string,
    input: {
      name?: string;
      systemPrompt?: string;
      modelId?: string;
    },
  ): Promise<BotResponse | null> {
    let updatedBot: BotResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      bots: config.bots.map((bot) => {
        if (bot.id !== botId) {
          return bot;
        }

        updatedBot = {
          ...bot,
          name: input.name ?? bot.name,
          systemPrompt: input.systemPrompt ?? bot.systemPrompt,
          modelId: input.modelId ?? bot.modelId,
          updatedAt: now(),
        };
        return updatedBot;
      }),
    }));

    return updatedBot;
  }

  async setBotStatus(
    botId: string,
    status: BotResponse["status"],
  ): Promise<BotResponse | null> {
    let updatedBot: BotResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      bots: config.bots.map((bot) => {
        if (bot.id !== botId) {
          return bot;
        }

        updatedBot = {
          ...bot,
          status,
          updatedAt: now(),
        };
        return updatedBot;
      }),
    }));

    return updatedBot;
  }

  async deleteBot(botId: string): Promise<boolean> {
    let deleted = false;

    await this.store.update((config) => {
      const bots = config.bots.filter((bot) => {
        if (bot.id === botId) {
          deleted = true;
          return false;
        }

        return true;
      });

      return {
        ...config,
        bots,
        channels: config.channels.filter((channel) => channel.botId !== botId),
      };
    });

    return deleted;
  }

  async listChannels(): Promise<ChannelResponse[]> {
    const config = await this.getConfig();
    return config.channels;
  }

  async getSecret(key: string): Promise<string | null> {
    const config = await this.getConfig();
    return config.secrets[key] ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      secrets: {
        ...config.secrets,
        [key]: value,
      },
    }));
  }

  async deleteSecretsByPrefix(prefix: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      secrets: Object.fromEntries(
        Object.entries(config.secrets).filter(
          ([key]) => !key.startsWith(prefix),
        ),
      ),
    }));
  }

  async getChannel(channelId: string): Promise<ChannelResponse | null> {
    const config = await this.getConfig();
    return config.channels.find((channel) => channel.id === channelId) ?? null;
  }

  async setChannelStatus(
    channelId: string,
    status: ChannelResponse["status"],
  ): Promise<ChannelResponse | null> {
    let updatedChannel: ChannelResponse | null = null;
    const updatedAt = now();

    await this.store.update((config) => ({
      ...config,
      channels: config.channels.map((channel) => {
        if (channel.id !== channelId) {
          return channel;
        }

        if (channel.status === status) {
          updatedChannel = channel;
          return channel;
        }

        updatedChannel = {
          ...channel,
          status,
          updatedAt,
        };
        return updatedChannel;
      }),
    }));

    return updatedChannel;
  }

  async reconcileSingleWechatChannel(): Promise<{
    changed: boolean;
    keptAccountId: string | null;
    removedCount: number;
  }> {
    let keptAccountId: string | null = null;
    let keptChannelId: string | null = null;
    let removedCount = 0;

    await this.store.update((config) => {
      const wechatChannels = config.channels.filter(
        (channel) => channel.channelType === "wechat",
      );

      if (wechatChannels.length <= 1) {
        keptAccountId = wechatChannels[0]?.accountId ?? null;
        keptChannelId = wechatChannels[0]?.id ?? null;
        return config;
      }

      const keptChannel =
        [...wechatChannels].sort((a, b) => {
          const aTime = Date.parse(a.updatedAt || a.createdAt);
          const bTime = Date.parse(b.updatedAt || b.createdAt);
          return (
            (Number.isFinite(bTime) ? bTime : 0) -
            (Number.isFinite(aTime) ? aTime : 0)
          );
        })[0] ?? null;
      keptAccountId = keptChannel?.accountId ?? null;
      keptChannelId = keptChannel?.id ?? null;
      removedCount = keptChannel ? wechatChannels.length - 1 : 0;

      return {
        ...config,
        channels: config.channels.filter(
          (channel) =>
            channel.channelType !== "wechat" || channel.id === keptChannelId,
        ),
      };
    });

    if (removedCount > 0) {
      logger.info(
        {
          keptAccountId,
          removedCount,
        },
        "wechat_channels_reconciled_single_account",
      );
    }

    return {
      changed: removedCount > 0,
      keptAccountId,
      removedCount,
    };
  }

  async resetWechatChannelsForFreshLogin(): Promise<{
    changed: boolean;
    removedCount: number;
  }> {
    let removedCount = 0;

    await this.store.update((config) => {
      const nextChannels = config.channels.filter((channel) => {
        const remove = channel.channelType === "wechat";
        if (remove) {
          removedCount += 1;
        }
        return !remove;
      });

      if (removedCount === 0) {
        return config;
      }

      return {
        ...config,
        channels: nextChannels,
      };
    });

    if (removedCount > 0) {
      logger.info({ removedCount }, "wechat_channels_reset_for_fresh_login");
    }

    return {
      changed: removedCount > 0,
      removedCount,
    };
  }

  async connectSlack(
    input: ConnectSlackInput & { botUserId?: string | null },
  ): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const teamId = input.teamId ?? crypto.randomUUID();
    const appId = input.appId ?? crypto.randomUUID();
    const accountId = `slack-${appId}-${teamId}`;
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "slack",
      accountId,
      status: "connected",
      teamName: input.teamName ?? null,
      appId,
      botUserId: input.botUserId ?? null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      channels: [
        ...config.channels.filter(
          (existing) =>
            !(
              existing.channelType === channel.channelType &&
              existing.accountId === channel.accountId
            ),
        ),
        channel,
      ],
      secrets: {
        ...config.secrets,
        [`channel:${channel.id}:botToken`]: input.botToken,
        [`channel:${channel.id}:signingSecret`]: input.signingSecret,
      },
    }));

    return channel;
  }

  async connectDiscord(
    input: ConnectDiscordInput & { botUserId?: string | null },
  ): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "discord",
      accountId: `discord-${input.appId}`,
      status: "connected",
      teamName: input.guildName ?? null,
      appId: input.appId,
      botUserId: input.botUserId ?? null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      channels: [
        ...config.channels.filter(
          (existing) =>
            !(
              existing.channelType === channel.channelType &&
              existing.accountId === channel.accountId
            ),
        ),
        channel,
      ],
      secrets: {
        ...config.secrets,
        [`channel:${channel.id}:botToken`]: input.botToken,
      },
    }));

    return channel;
  }

  async connectWechat(input: { accountId: string }): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "wechat",
      accountId: input.accountId,
      status: "connected",
      teamName: null,
      appId: null,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      channels: [
        ...config.channels.filter(
          (existing) => existing.channelType !== channel.channelType,
        ),
        channel,
      ],
    }));

    return channel;
  }

  async connectTelegram(input: {
    botToken: string;
    telegramBotId: string;
    botUsername: string | null;
    displayName: string | null;
  }): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const accountId = `telegram-${input.telegramBotId}`;
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "telegram",
      accountId,
      status: "connected",
      teamName: input.displayName,
      appId: input.telegramBotId,
      botUserId: input.botUsername,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      ...(() => {
        const previous = config.channels.find(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        );
        const secrets = { ...config.secrets };
        if (previous) {
          delete secrets[`channel:${previous.id}:botToken`];
          delete secrets[`channel:${previous.id}:authDir`];
        }
        secrets[`channel:${channel.id}:botToken`] = input.botToken;
        return { secrets };
      })(),
      channels: [
        ...config.channels.filter(
          (existing) =>
            !(
              existing.channelType === channel.channelType &&
              existing.accountId === channel.accountId
            ),
        ),
        channel,
      ],
    }));

    return channel;
  }

  async connectWhatsapp(input: {
    accountId: string;
    authDir?: string | null;
  }): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "whatsapp",
      accountId: input.accountId,
      status: "connected",
      teamName: null,
      appId: null,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      ...(() => {
        const previous = config.channels.find(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        );
        const secrets = { ...config.secrets };
        if (previous) {
          delete secrets[`channel:${previous.id}:botToken`];
          delete secrets[`channel:${previous.id}:authDir`];
        }
        if (input.authDir) {
          secrets[`channel:${channel.id}:authDir`] = input.authDir;
        }
        return { secrets };
      })(),
      channels: [
        ...config.channels.filter(
          (existing) =>
            !(
              existing.channelType === channel.channelType &&
              existing.accountId === channel.accountId
            ),
        ),
        channel,
      ],
    }));

    return channel;
  }

  async connectFeishu(input: ConnectFeishuInput): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "feishu",
      accountId: input.appId,
      status: "connected",
      teamName: null,
      appId: input.appId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      channels: [
        ...config.channels.filter(
          (existing) =>
            !(
              existing.channelType === channel.channelType &&
              existing.accountId === channel.accountId
            ),
        ),
        channel,
      ],
      secrets: {
        ...config.secrets,
        [`channel:${channel.id}:appSecret`]: input.appSecret,
        [`channel:${channel.id}:appId`]: input.appId,
        [`channel:${channel.id}:connectionMode`]:
          input.connectionMode ?? "websocket",
        ...(input.verificationToken
          ? {
              [`channel:${channel.id}:verificationToken`]:
                input.verificationToken,
            }
          : {}),
      },
    }));

    return channel;
  }

  async connectQqbot(input: ConnectQqbotInput): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const accountId = `qqbot-${input.appId}`;
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "qqbot",
      accountId,
      status: "connected",
      teamName: null,
      appId: input.appId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      ...(() => {
        const previous = config.channels.find(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        );
        const secrets = { ...config.secrets };
        if (previous) {
          delete secrets[`channel:${previous.id}:appId`];
          delete secrets[`channel:${previous.id}:appSecret`];
          delete secrets[`channel:${previous.id}:clientSecret`];
        }
        secrets[`channel:${channel.id}:appId`] = input.appId;
        secrets[`channel:${channel.id}:appSecret`] = input.appSecret;
        secrets[`channel:${channel.id}:clientSecret`] = input.appSecret;
        return { secrets };
      })(),
      channels: [
        ...config.channels.filter(
          (existing) =>
            !(
              existing.channelType === channel.channelType &&
              existing.accountId === channel.accountId
            ),
        ),
        channel,
      ],
    }));

    return channel;
  }

  async connectDingtalk(input: ConnectDingtalkInput): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "dingtalk",
      accountId: DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID,
      status: "connected",
      teamName: null,
      appId: input.clientId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      channels: [
        ...config.channels.filter(
          (existing) => existing.channelType !== channel.channelType,
        ),
        channel,
      ],
      secrets: {
        ...config.secrets,
        [`channel:${channel.id}:clientId`]: input.clientId,
        [`channel:${channel.id}:clientSecret`]: input.clientSecret,
      },
    }));

    return channel;
  }

  async connectWecom(input: ConnectWecomInput): Promise<ChannelResponse> {
    const bot = await this.getOrCreateDefaultBot();
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "wecom",
      accountId: DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID,
      status: "connected",
      teamName: null,
      appId: input.botId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => ({
      ...config,
      channels: [
        ...config.channels.filter(
          (existing) => existing.channelType !== channel.channelType,
        ),
        channel,
      ],
      secrets: {
        ...config.secrets,
        [`channel:${channel.id}:botId`]: input.botId,
        [`channel:${channel.id}:secret`]: input.secret,
      },
    }));

    return channel;
  }

  async disconnectChannel(channelId: string): Promise<boolean> {
    let disconnectedChannel: ChannelResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      channels: config.channels.flatMap((channel) => {
        if (channel.id === channelId) {
          disconnectedChannel = channel;
          if (channel.channelType === "feishu") {
            return [
              {
                ...channel,
                status: "disconnected",
                updatedAt: new Date().toISOString(),
              },
            ];
          }

          return [];
        }

        return [channel];
      }),
      secrets:
        disconnectedChannel === null ||
        disconnectedChannel.channelType === "feishu"
          ? config.secrets
          : Object.fromEntries(
              Object.entries(config.secrets).filter(
                ([key]) => !key.startsWith(`channel:${channelId}:`),
              ),
            ),
    }));

    return disconnectedChannel !== null;
  }

  async listProviders(): Promise<ProviderResponse[]> {
    const config = await this.getConfig();
    return config.providers.map((provider) => serializeProvider(provider));
  }

  async getProvider(
    providerId: string,
  ): Promise<StoredProviderResponse | null> {
    const config = await this.getConfig();
    const provider =
      config.providers.find((item) => item.providerId === providerId) ?? null;
    return provider ? serializeProvider(provider) : null;
  }

  async upsertProvider(
    providerId: string,
    input: UpsertProviderBody,
  ): Promise<{ provider: StoredProviderResponse; created: boolean }> {
    const currentTime = now();
    let result: ControllerProvider | null = null;
    let created = false;

    await this.store.update((config) => {
      const existing = config.providers.find(
        (item) => item.providerId === providerId,
      );
      const nextProvider: ControllerProvider = existing
        ? {
            ...existing,
            displayName: input.displayName ?? existing.displayName,
            enabled: input.enabled ?? existing.enabled,
            authMode: input.authMode ?? existing.authMode,
            baseUrl:
              input.baseUrl === undefined ? existing.baseUrl : input.baseUrl,
            apiKey: input.apiKey === undefined ? existing.apiKey : input.apiKey,
            oauthRegion:
              input.authMode === "apiKey" ? null : existing.oauthRegion,
            oauthCredential:
              input.authMode === "apiKey" ? null : existing.oauthCredential,
            models:
              input.modelsJson === undefined
                ? existing.models
                : parseModelsJson(input.modelsJson),
            updatedAt: currentTime,
          }
        : {
            id: crypto.randomUUID(),
            providerId,
            displayName: input.displayName ?? providerId,
            enabled: input.enabled ?? true,
            baseUrl: input.baseUrl ?? null,
            authMode: input.authMode ?? "apiKey",
            apiKey: input.apiKey ?? null,
            oauthRegion: null,
            oauthCredential: null,
            models: parseModelsJson(input.modelsJson),
            createdAt: currentTime,
            updatedAt: currentTime,
          };

      if (nextProvider.authMode === "apiKey") {
        nextProvider.oauthRegion = null;
        nextProvider.oauthCredential = null;
      }

      created = existing === undefined;
      result = nextProvider;

      return {
        ...config,
        providers: existing
          ? config.providers.map((item) =>
              item.providerId === providerId ? nextProvider : item,
            )
          : [...config.providers, nextProvider],
      };
    });

    if (result === null) {
      throw new Error(`Failed to upsert provider ${providerId}`);
    }

    return {
      provider: serializeProvider(result),
      created,
    };
  }

  async setProviderOauthCredentials(
    providerId: string,
    input: {
      displayName?: string;
      enabled?: boolean;
      baseUrl?: string | null;
      models: string[];
      oauthRegion: "global" | "cn";
      oauthCredential: {
        provider: string;
        access: string;
        refresh?: string;
        expires?: number;
        email?: string;
      };
    },
  ): Promise<StoredProviderResponse> {
    const currentTime = now();
    let result: ControllerProvider | null = null;

    await this.store.update((config) => {
      const existing = config.providers.find(
        (item) => item.providerId === providerId,
      );
      const nextProvider: ControllerProvider = existing
        ? {
            ...existing,
            displayName: input.displayName ?? existing.displayName,
            enabled: input.enabled ?? true,
            baseUrl:
              input.baseUrl === undefined ? existing.baseUrl : input.baseUrl,
            authMode: "oauth",
            apiKey: null,
            oauthRegion: input.oauthRegion,
            oauthCredential: input.oauthCredential,
            models: [...input.models],
            updatedAt: currentTime,
          }
        : {
            id: crypto.randomUUID(),
            providerId,
            displayName: input.displayName ?? providerId,
            enabled: input.enabled ?? true,
            baseUrl: input.baseUrl ?? null,
            authMode: "oauth",
            apiKey: null,
            oauthRegion: input.oauthRegion,
            oauthCredential: input.oauthCredential,
            models: [...input.models],
            createdAt: currentTime,
            updatedAt: currentTime,
          };

      result = nextProvider;

      return {
        ...config,
        providers: existing
          ? config.providers.map((item) =>
              item.providerId === providerId ? nextProvider : item,
            )
          : [...config.providers, nextProvider],
      };
    });

    if (result === null) {
      throw new Error(`Failed to set oauth provider ${providerId}`);
    }

    return serializeProvider(result);
  }

  async deleteProvider(providerId: string): Promise<boolean> {
    let deleted = false;

    await this.store.update((config) => ({
      ...config,
      providers: config.providers.filter((provider) => {
        if (provider.providerId === providerId) {
          deleted = true;
          return false;
        }

        return true;
      }),
    }));

    return deleted;
  }

  async listIntegrations(): Promise<IntegrationResponse[]> {
    const config = await this.getConfig();
    return config.integrations;
  }

  async getLocalProfile(): Promise<UserProfileResponse> {
    const config = await this.getConfig();
    const profile = readLocalProfile(config);
    const cloud = readDesktopCloud(config);

    if (cloud.connected) {
      return {
        ...profile,
        ...(cloud.userEmail ? { email: cloud.userEmail } : {}),
        ...(cloud.userName ? { name: cloud.userName } : {}),
      };
    }

    return profile;
  }

  async updateLocalProfile(
    input: UpdateUserProfileInput,
  ): Promise<UserProfileResponse> {
    let nextProfile = defaultLocalProfile();

    await this.store.update((config) => {
      const currentProfile = readLocalProfile(config);
      nextProfile = {
        ...currentProfile,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
      };

      return {
        ...config,
        desktop: {
          ...config.desktop,
          localProfile: nextProfile,
        },
      };
    });

    return nextProfile;
  }

  async updateLocalAuthSource(
    input: UpdateAuthSourceInput,
  ): Promise<UserProfileResponse> {
    let nextProfile = defaultLocalProfile();

    await this.store.update((config) => {
      const currentProfile = readLocalProfile(config);
      nextProfile = {
        ...currentProfile,
        authSource: input.source,
      };

      return {
        ...config,
        desktop: {
          ...config.desktop,
          localProfile: nextProfile,
        },
      };
    });

    return nextProfile;
  }

  async getDesktopCloudStatus() {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    const models =
      (cloud.models?.length ?? 0) > 0 || cloud.apiKey
        ? normalizeDesktopCloudModels(cloud.models)
        : (cloud.models ?? []);
    const cloudSessions = readDesktopCloudSessions(config);
    const { profiles, activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    return {
      connected: cloud.connected,
      polling: cloud.polling,
      userName: cloud.userName ?? null,
      userEmail: cloud.userEmail ?? null,
      connectedAt: cloud.connectedAt ?? null,
      models,
      cloudUrl: activeProfile.cloudUrl,
      linkUrl: activeProfile.linkUrl,
      activeProfileName: activeProfile.name,
      profiles: profiles.map((profile) => {
        const session =
          cloudSessions[profile.name] ??
          (profile.name === activeProfile.name ? cloud : undefined);

        return {
          ...profile,
          connected: session?.connected === true,
          polling: session?.polling === true,
          userName: session?.userName ?? null,
          userEmail: session?.userEmail ?? null,
          connectedAt: session?.connectedAt ?? null,
          modelCount: session?.models?.length ?? 0,
        };
      }),
    };
  }

  async getStoredDesktopLocale(): Promise<"en" | "zh-CN" | null> {
    const config = await this.getConfig();
    return readDesktopLocale(config);
  }

  async getDesktopLocale(): Promise<"en" | "zh-CN"> {
    return (await this.getStoredDesktopLocale()) ?? "en";
  }

  async setDesktopLocale(locale: "en" | "zh-CN"): Promise<"en" | "zh-CN"> {
    await this.store.update((config) => ({
      ...config,
      desktop: {
        ...config.desktop,
        locale,
      },
    }));

    return locale;
  }

  async refreshDesktopCloudModels() {
    await this.hydrateDesktopCloudModels();
    return this.getDesktopCloudStatus();
  }

  async shouldSkipCloudHydrationForBootstrap(): Promise<boolean> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    if (!cloud.connected || (cloud.models?.length ?? 0) === 0) {
      return false;
    }

    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    const expectedCacheKey = buildDesktopCloudCacheKey(activeProfile);
    const cacheMatches =
      cloud.cacheKey === expectedCacheKey ||
      (cloud.cacheKey === null && cloud.linkUrl === activeProfile.linkUrl);
    if (!cacheMatches) {
      return false;
    }

    if (typeof cloud.modelsUpdatedAt !== "number") {
      return true;
    }

    return Date.now() - cloud.modelsUpdatedAt < CLOUD_BOOTSTRAP_CACHE_TTL_MS;
  }

  async prepareDesktopCloudModelsForBootstrap(): Promise<void> {
    await this.hydrateDesktopCloudModels();
  }

  async getDesktopCloudInventoryStatus(): Promise<{
    connected: boolean;
    hasCloudInventory: boolean;
  }> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    return {
      connected: cloud.connected,
      hasCloudInventory: (cloud.models?.length ?? 0) > 0,
    };
  }

  async setDefaultModel(modelId: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      runtime: {
        ...config.runtime,
        defaultModelId: modelId,
      },
      bots: config.bots.map((bot) => ({
        ...bot,
        modelId,
        updatedAt: now(),
      })),
    }));
  }

  async setDefaultImageGenerationModel(modelId: string): Promise<void> {
    const normalizedModelId = normalizeDesktopCloudImageModelId(modelId);
    await this.store.update((config) => ({
      ...config,
      runtime: {
        ...config.runtime,
        defaultImageGenerationModelId: normalizedModelId,
      },
    }));
  }

  async markFastDefaultModelMigrationComplete(): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      desktop: {
        ...config.desktop,
        [FAST_DEFAULT_MIGRATION_KEY]: true,
      },
    }));
  }

  private async fetchDesktopCloudModels(
    modelsUrl: string,
    apiKey?: string,
  ): Promise<CloudModel[] | null> {
    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const res = await proxyFetch(modelsUrl, {
        headers,
        timeoutMs: 10000,
      });
      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as {
        data?: Array<{ id: string; name?: string; owned_by?: string }>;
      };
      if (!Array.isArray(data.data)) {
        return null;
      }

      return normalizeDesktopCloudModels(
        data.data.map((model) => ({
          id: model.id,
          name: model.name || model.id,
          provider: model.owned_by,
        })),
      );
    } catch {
      return null;
    }
  }

  private async hydrateDesktopCloudModels(): Promise<void> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    const cacheKey = buildDesktopCloudCacheKey(activeProfile);
    const linkUrl = await this.resolveDesktopCloudLinkUrl(
      config,
      cloud.linkUrl,
    );

    if (cloud.connected && cloud.linkUrl !== linkUrl) {
      await this.setDesktopCloudState({
        connected: cloud.connected,
        polling: cloud.polling,
        userName: cloud.userName ?? null,
        userEmail: cloud.userEmail ?? null,
        connectedAt: cloud.connectedAt ?? null,
        linkUrl,
        apiKey: cloud.apiKey ?? null,
        models: cloud.models ?? [],
        cacheKey: cloud.cacheKey ?? cacheKey,
        modelsUpdatedAt: cloud.modelsUpdatedAt ?? null,
      });
    }

    const curatedModels = await this.fetchDesktopCloudModels(
      buildLinkModelsUrl(activeProfile.cloudUrl),
    );
    const supplementalModels =
      cloud.connected && cloud.apiKey
        ? await this.fetchDesktopCloudModels(
            buildLinkModelsUrl(linkUrl),
            cloud.apiKey,
          )
        : null;

    if (curatedModels && curatedModels.length > 0) {
      const models = mergeDesktopCloudModelCatalogs({
        curatedModels,
        supplementalModels: supplementalModels ?? cloud.models ?? null,
      });
      await this.setDesktopCloudState({
        connected: cloud.connected,
        polling: cloud.polling,
        userName: cloud.userName ?? null,
        userEmail: cloud.userEmail ?? null,
        connectedAt: cloud.connectedAt ?? null,
        linkUrl,
        apiKey: cloud.apiKey ?? null,
        models,
        cacheKey,
        modelsUpdatedAt: Date.now(),
      });
      await this.alignDefaultModelToCuratedList(models);
      return;
    }

    if (supplementalModels !== null || (cloud.models?.length ?? 0) > 0) {
      const models = pickSupplementalDesktopCloudModels(
        supplementalModels ?? cloud.models ?? [],
      );
      if (models.length > 0) {
        await this.setDesktopCloudState({
          connected: cloud.connected,
          polling: cloud.polling,
          userName: cloud.userName ?? null,
          userEmail: cloud.userEmail ?? null,
          connectedAt: cloud.connectedAt ?? null,
          linkUrl,
          apiKey: cloud.apiKey ?? null,
          models,
          cacheKey,
          modelsUpdatedAt: Date.now(),
        });
        await this.alignDefaultModelToCuratedList(models);
        return;
      }
    }

    if ((cloud.models?.length ?? 0) > 0 || !cloud.apiKey) {
      if (cloud.cacheKey !== cacheKey || cloud.modelsUpdatedAt === null) {
        await this.setDesktopCloudState({
          connected: cloud.connected,
          polling: cloud.polling,
          userName: cloud.userName ?? null,
          userEmail: cloud.userEmail ?? null,
          connectedAt: cloud.connectedAt ?? null,
          linkUrl,
          apiKey: cloud.apiKey ?? null,
          models: cloud.models ?? [],
          cacheKey,
          modelsUpdatedAt: cloud.modelsUpdatedAt ?? Date.now(),
        });
      }
      return;
    }

    return;
  }

  private async alignDefaultModelToCuratedList(
    curatedModels: CloudModel[],
  ): Promise<void> {
    if (curatedModels.length === 0) {
      return;
    }
    const config = await this.getConfig();
    const currentDefault = config.runtime.defaultModelId;
    const bare = currentDefault.startsWith("link/")
      ? currentDefault.slice(5)
      : currentDefault;
    if (curatedModels.some((m) => m.id === bare)) {
      return;
    }
    if (DESKTOP_CLOUD_SUPPLEMENTAL_MODEL_IDS.has(bare)) {
      return;
    }
    const envDefault = this.env.defaultModelId;
    const envBare = envDefault.startsWith("link/")
      ? envDefault.slice(5)
      : envDefault;
    if (curatedModels.some((m) => m.id === envBare)) {
      await this.setDefaultModel(envDefault);
      return;
    }
    const fallback = curatedModels[0];
    if (fallback) {
      await this.setDefaultModel(`link/${fallback.id}`);
    }
  }

  async connectDesktopCloud() {
    const config = await this.getConfig();
    const current = readDesktopCloud(config);
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    if (this.pollingState || current.polling) {
      return { error: "Connection attempt already in progress" };
    }
    if (current.connected && current.apiKey) {
      return { error: "Already connected. Disconnect first." };
    }

    const deviceId = crypto.randomUUID();
    const deviceSecret = crypto.randomUUID();
    const deviceSecretHash = crypto
      .createHash("sha256")
      .update(deviceSecret)
      .digest("hex");

    let res: Response;
    const registerUrl = `${activeProfile.cloudUrl}/api/auth/device-register`;
    try {
      res = await proxyFetch(registerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceSecretHash }),
        timeoutMs: 10_000,
      });
    } catch (error) {
      logger.warn(
        {
          url: registerUrl,
          error: describeFetchError(error),
        },
        "desktop_cloud_connect_register_failed",
      );
      return {
        error: `Cloud unreachable: ${describeFetchError(error)}`,
      };
    }

    if (!res.ok) {
      return { error: `Failed to register device: ${await res.text()}` };
    }

    await this.setDesktopCloudState({
      connected: false,
      polling: true,
      userName: null,
      userEmail: null,
      connectedAt: null,
      linkUrl: null,
      apiKey: null,
      models: [],
    });

    const abortController = new AbortController();
    this.pollingState = { deviceId, deviceSecret, abortController };
    void this.pollDesktopCloudAuthorization(
      activeProfile.cloudUrl,
      deviceId,
      deviceSecret,
      abortController.signal,
    );

    return {
      browserUrl: `${activeProfile.cloudUrl}/auth?desktop=1&device_id=${encodeURIComponent(deviceId)}`,
      error: undefined,
    };
  }

  async setDesktopCloudProfiles(profiles: CloudProfileInput[]) {
    const normalizedProfiles = normalizeImportedCloudProfiles(profiles);
    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    const config = await this.getConfig();
    const activeProfileName = readDesktopActiveCloudProfileName(config);
    const activeProfile = this.resolveActiveCloudProfile(
      normalizedProfiles,
      activeProfileName,
    );

    await this.store.update((currentConfig) => {
      const sessions = readDesktopCloudSessions(currentConfig);
      const allowedNames = new Set(
        normalizedProfiles.map((profile) => profile.name),
      );
      const nextSessions = Object.fromEntries(
        Object.entries(sessions).filter(([name]) => allowedNames.has(name)),
      );

      return {
        ...currentConfig,
        desktop: {
          ...currentConfig.desktop,
          activeCloudProfileName: activeProfile.name,
          cloudSessions: nextSessions,
        },
      };
    });

    return this.getDesktopCloudStatus();
  }

  async createDesktopCloudProfile(profile: CloudProfileInput) {
    if (isDefaultCloudProfileName(profile.name)) {
      throw new Error("Default cloud profile name is reserved.");
    }

    const existingProfiles = await this.listStoredCloudProfiles();
    if (existingProfiles.some((item) => item.name === profile.name.trim())) {
      throw new Error(`Cloud profile already exists: ${profile.name.trim()}`);
    }

    const normalizedProfiles = normalizeImportedCloudProfiles([
      ...existingProfiles,
      {
        name: profile.name.trim(),
        cloudUrl: profile.cloudUrl.trim(),
        linkUrl: profile.linkUrl.trim(),
      },
    ]);

    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    return this.getDesktopCloudStatus();
  }

  async updateDesktopCloudProfile(
    previousName: string,
    profile: CloudProfileInput,
  ) {
    if (
      isDefaultCloudProfileName(previousName) ||
      isDefaultCloudProfileName(profile.name)
    ) {
      throw new Error("Default cloud profile cannot be edited.");
    }

    const existingProfiles = await this.listStoredCloudProfiles();
    if (!existingProfiles.some((item) => item.name === previousName)) {
      throw new Error(`Unknown cloud profile: ${previousName}`);
    }

    const nextProfiles = existingProfiles.map((item) =>
      item.name === previousName
        ? {
            name: profile.name.trim(),
            cloudUrl: profile.cloudUrl.trim(),
            linkUrl: profile.linkUrl.trim(),
          }
        : item,
    );

    const normalizedProfiles = normalizeImportedCloudProfiles(nextProfiles);
    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    await this.store.update((config) => {
      const sessions = readDesktopCloudSessions(config);
      const previousSession = sessions[previousName];
      const { [previousName]: _removed, ...restSessions } = sessions;

      return {
        ...config,
        desktop: {
          ...config.desktop,
          activeCloudProfileName:
            readDesktopActiveCloudProfileName(config) === previousName
              ? profile.name.trim()
              : readDesktopActiveCloudProfileName(config),
          cloudSessions: previousSession
            ? {
                ...restSessions,
                [profile.name.trim()]: previousSession,
              }
            : restSessions,
        },
      };
    });

    return this.getDesktopCloudStatus();
  }

  async deleteDesktopCloudProfile(name: string) {
    if (isDefaultCloudProfileName(name)) {
      throw new Error("Default cloud profile cannot be deleted.");
    }

    const existingProfiles = await this.listStoredCloudProfiles();
    if (!existingProfiles.some((item) => item.name === name)) {
      throw new Error(`Unknown cloud profile: ${name}`);
    }

    const normalizedProfiles = existingProfiles.filter(
      (item) => item.name !== name,
    );
    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    const previousCloud = readDesktopCloud(await this.getConfig());

    if (this.pollingState) {
      this.pollingState.abortController.abort();
      this.pollingState = null;
    }

    await this.store.update((config) => {
      const currentProfile = readLocalProfile(config);
      const shouldResetActive =
        readDesktopActiveCloudProfileName(config) === name;
      const sessions = readDesktopCloudSessions(config);
      const { [name]: _removed, ...restSessions } = sessions;

      return {
        ...config,
        desktop: {
          ...config.desktop,
          localProfile: {
            ...currentProfile,
            authSource: shouldResetActive
              ? "desktop-local"
              : currentProfile.authSource,
          },
          activeCloudProfileName: shouldResetActive
            ? defaultCloudProfile.name
            : readDesktopActiveCloudProfileName(config),
          cloudSessions: restSessions,
          cloud: shouldResetActive
            ? {
                connected: false,
                polling: false,
                userName: null,
                userEmail: null,
                connectedAt: null,
                linkUrl: null,
                apiKey: null,
                models: [],
              }
            : config.desktop.cloud,
        },
      };
    });

    if (
      readDesktopActiveCloudProfileName(await this.getConfig()) ===
      defaultCloudProfile.name
    ) {
      await this.onCloudStateChanged?.({
        hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
        hasCloudInventory: false,
        connected: false,
      });
    }

    return this.getDesktopCloudStatus();
  }

  async switchDesktopCloudProfile(name: string) {
    const config = await this.getConfig();
    const previousCloud = readDesktopCloud(config);
    const profiles = await this.listStoredCloudProfiles();
    const nextProfile = profiles.find((profile) => profile.name === name);

    if (!nextProfile) {
      throw new Error(`Unknown cloud profile: ${name}`);
    }

    if (this.pollingState) {
      this.pollingState.abortController.abort();
      this.pollingState = null;
    }

    await this.store.update((currentConfig) => {
      const currentProfile = readLocalProfile(currentConfig);
      const sessions = readDesktopCloudSessions(currentConfig);
      const nextSession = sessions[nextProfile.name];

      return {
        ...currentConfig,
        desktop: {
          ...currentConfig.desktop,
          localProfile: {
            ...currentProfile,
            authSource: nextSession?.connected ? "cloud" : "desktop-local",
          },
          activeCloudProfileName: nextProfile.name,
          cloud: nextSession
            ? {
                connected: nextSession.connected,
                polling: nextSession.polling,
                userName: nextSession.userName ?? null,
                userEmail: nextSession.userEmail ?? null,
                connectedAt: nextSession.connectedAt ?? null,
                linkUrl: nextSession.linkUrl ?? null,
                apiKey: nextSession.apiKey ?? null,
                models: nextSession.models ?? [],
              }
            : {
                connected: false,
                polling: false,
                userName: null,
                userEmail: null,
                connectedAt: null,
                linkUrl: null,
                apiKey: null,
                models: [],
              },
        },
      };
    });

    const switchedConfig = await this.getConfig();
    const switchedCloud = readDesktopCloud(switchedConfig);
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(switchedConfig);
    const cacheKey = buildDesktopCloudCacheKey(activeProfile);
    let nextModels = switchedCloud.models ?? [];
    let nextCacheKey = switchedCloud.cacheKey ?? cacheKey;
    let nextModelsUpdatedAt = switchedCloud.modelsUpdatedAt ?? null;

    if (switchedCloud.connected && switchedCloud.apiKey) {
      const refreshedModels = await this.fetchDesktopCloudModels(
        nextProfile.linkUrl,
        switchedCloud.apiKey,
      );
      nextModels = refreshedModels ?? nextModels;
      if (refreshedModels) {
        nextCacheKey = cacheKey;
        nextModelsUpdatedAt = Date.now();
      }
    }

    await this.setDesktopCloudState({
      connected: switchedCloud.connected,
      polling: false,
      userName: switchedCloud.userName ?? null,
      userEmail: switchedCloud.userEmail ?? null,
      connectedAt: switchedCloud.connectedAt ?? null,
      linkUrl: switchedCloud.connected ? nextProfile.linkUrl : null,
      apiKey: switchedCloud.apiKey ?? null,
      models: switchedCloud.connected ? nextModels : [],
      cacheKey: switchedCloud.connected ? nextCacheKey : null,
      modelsUpdatedAt: switchedCloud.connected ? nextModelsUpdatedAt : null,
    });

    await this.onCloudStateChanged?.({
      hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
      hasCloudInventory: nextModels.length > 0,
      connected: switchedCloud.connected,
    });

    return this.getDesktopCloudStatus();
  }

  async connectDesktopCloudProfile(name: string) {
    const config = await this.getConfig();
    const activeProfileName = readDesktopActiveCloudProfileName(config);

    if (activeProfileName !== name) {
      await this.switchDesktopCloudProfile(name);
    }

    const status = await this.getDesktopCloudStatus();
    const targetProfile = status.profiles.find(
      (profile) => profile.name === name,
    );
    if (targetProfile?.connected) {
      return { browserUrl: undefined, error: undefined, status };
    }

    const result = await this.connectDesktopCloud();
    return {
      browserUrl: result.browserUrl,
      error: result.error,
      status: await this.getDesktopCloudStatus(),
    };
  }

  async disconnectDesktopCloudProfile(name: string) {
    const config = await this.getConfig();
    const activeProfileName = readDesktopActiveCloudProfileName(config);

    if (activeProfileName === name) {
      await this.disconnectDesktopCloud();
      return this.getDesktopCloudStatus();
    }

    await this.store.update((currentConfig) => {
      const sessions = readDesktopCloudSessions(currentConfig);
      const nextSession = sessions[name];

      if (!nextSession) {
        return currentConfig;
      }

      return {
        ...currentConfig,
        desktop: {
          ...currentConfig.desktop,
          cloudSessions: {
            ...sessions,
            [name]: {
              connected: false,
              polling: false,
              userName: null,
              userEmail: null,
              connectedAt: null,
              linkUrl: null,
              apiKey: null,
              models: [],
            },
          },
        },
      };
    });

    return this.getDesktopCloudStatus();
  }

  async disconnectDesktopCloud() {
    const previousCloud = readDesktopCloud(await this.getConfig());
    if (this.pollingState) {
      this.pollingState.abortController.abort();
      this.pollingState = null;
    }

    await this.setDesktopCloudState({
      connected: false,
      polling: false,
      userName: null,
      userEmail: null,
      connectedAt: null,
      linkUrl: null,
      apiKey: null,
      models: [],
    });
    await this.onCloudStateChanged?.({
      hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
      hasCloudInventory: false,
      connected: false,
    });

    return { ok: true };
  }

  async getActivationStatus(): Promise<{
    activated: boolean;
    email: string | null;
    activatedAt: string | null;
    codePrefix: string | null;
  }> {
    const config = await this.getConfig();
    const activation = readDesktopActivation(config);
    return {
      activated: activation.activated,
      email: activation.email,
      activatedAt: activation.activatedAt,
      codePrefix: activation.codePrefix,
    };
  }

  async getActivationJwt(): Promise<string | null> {
    const config = await this.getConfig();
    const activation = readDesktopActivation(config);
    return activation.jwt;
  }

  async setActivationState(input: {
    activated: boolean;
    email: string | null;
    jwt: string | null;
    apiKey: string | null;
    activatedAt: string | null;
    codePrefix: string | null;
  }): Promise<void> {
    await this.store.update((config) => {
      return {
        ...config,
        desktop: {
          ...config.desktop,
          activation: {
            activated: input.activated,
            email: input.email,
            jwt: input.jwt,
            apiKey: input.apiKey,
            activatedAt: input.activatedAt,
            codePrefix: input.codePrefix,
          },
        },
      };
    });
  }

  async clearActivation(): Promise<void> {
    await this.store.update((config) => {
      return {
        ...config,
        desktop: {
          ...config.desktop,
          activation: {
            activated: false,
            email: null,
            jwt: null,
            apiKey: null,
            activatedAt: null,
            codePrefix: null,
          },
        },
      };
    });
  }

  async applyActivationCloudState(input: {
    connected: boolean;
    polling: boolean;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    linkUrl?: string | null;
    apiKey?: string | null;
    models?: Array<{ id: string; name: string; provider?: string }>;
  }): Promise<void> {
    await this.setDesktopCloudState(input);
  }

  async setDesktopCloudModels(enabledModelIds: string[]) {
    await this.store.update((config) => {
      const cloud = readDesktopCloud(config);
      return {
        ...config,
        desktop: {
          ...config.desktop,
          cloud: {
            ...cloud,
            models: (cloud.models ?? []).filter((model) =>
              enabledModelIds.includes(model.id),
            ),
          },
        },
      };
    });

    const next = await this.getDesktopCloudStatus();
    return {
      ok: true,
      models: next.models,
    };
  }

  async connectIntegration(
    input: ConnectIntegrationInput,
  ): Promise<ConnectIntegrationResponse> {
    const timestamp = now();
    const integrationId = crypto.randomUUID();
    const integration: IntegrationResponse = {
      id: integrationId,
      toolkit: {
        slug: input.toolkitSlug,
        displayName: input.toolkitSlug,
        description: "Controller-managed integration",
        iconUrl: `/toolkit-icons/${input.toolkitSlug}.svg`,
        fallbackIconUrl: "https://www.google.com/s2/favicons?sz=64",
        category: "tooling",
        authScheme: input.credentials ? "api_key_user" : "oauth2",
        authFields: input.credentials
          ? Object.keys(input.credentials).map((key) => ({
              key,
              label: key,
              type: "secret" as const,
            }))
          : undefined,
      },
      status: input.credentials ? "active" : "initiated",
      connectUrl:
        input.credentials === undefined
          ? `${input.returnTo ?? "/"}?integration=${input.toolkitSlug}`
          : undefined,
      connectedAt: input.credentials ? timestamp : undefined,
      credentialHints: input.credentials
        ? Object.fromEntries(
            Object.keys(input.credentials).map((key) => [key, "***"]),
          )
        : undefined,
      returnTo: input.returnTo,
      source: input.source,
    };

    await this.store.update((config) => ({
      ...config,
      integrations: [
        ...config.integrations.filter(
          (item) => item.toolkit.slug !== input.toolkitSlug,
        ),
        integration,
      ],
      secrets: {
        ...config.secrets,
        ...Object.fromEntries(
          Object.entries(input.credentials ?? {})
            .filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            )
            .map(([key, value]) => [
              `integration:${integrationId}:${key}`,
              value,
            ]),
        ),
      },
    }));

    return {
      integration,
      connectUrl: integration.connectUrl,
      state: integration.id,
    };
  }

  async refreshIntegration(
    integrationId: string,
    _input: RefreshIntegrationInput,
  ): Promise<IntegrationResponse | null> {
    let updated: IntegrationResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      integrations: config.integrations.map((integration) => {
        if (integration.id !== integrationId) {
          return integration;
        }

        updated = {
          ...integration,
          status: "active",
          connectedAt: integration.connectedAt ?? now(),
        };

        return updated;
      }),
    }));

    return updated;
  }

  async deleteIntegration(
    integrationId: string,
  ): Promise<IntegrationResponse | null> {
    let removed: IntegrationResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      integrations: config.integrations.filter((integration) => {
        if (integration.id === integrationId) {
          removed = {
            ...integration,
            status: "disconnected",
          };
          return false;
        }

        return true;
      }),
      secrets: Object.fromEntries(
        Object.entries(config.secrets).filter(
          ([key]) => !key.startsWith(`integration:${integrationId}:`),
        ),
      ),
    }));

    return removed;
  }

  async getRuntimeConfig(): Promise<ControllerRuntimeConfig> {
    const config = await this.getConfig();
    return config.runtime;
  }

  async setRuntimeConfig(
    runtime: ControllerRuntimeConfig,
  ): Promise<ControllerRuntimeConfig> {
    await this.store.update((config) => ({
      ...config,
      runtime,
    }));

    return runtime;
  }

  async syncManagedRuntimeGateway(input: {
    port: number;
    authMode: ControllerRuntimeConfig["gateway"]["authMode"];
  }): Promise<void> {
    await this.store.update((config) => {
      if (
        config.runtime.gateway.port === input.port &&
        config.runtime.gateway.authMode === input.authMode
      ) {
        return config;
      }

      return {
        ...config,
        runtime: {
          ...config.runtime,
          gateway: {
            ...config.runtime.gateway,
            port: input.port,
            authMode: input.authMode,
          },
        },
      };
    });
  }

  async listTemplates() {
    const config = await this.getConfig();
    return Object.values(config.templates);
  }

  async upsertTemplate(input: {
    name: string;
    content: string;
    writeMode?: "seed" | "inject";
    status?: "active" | "inactive";
  }) {
    const existing = (await this.getConfig()).templates[input.name];
    const timestamp = now();
    const template = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      content: input.content,
      writeMode: input.writeMode ?? existing?.writeMode ?? "seed",
      status: input.status ?? existing?.status ?? "active",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await this.store.update((config) => ({
      ...config,
      templates: {
        ...config.templates,
        [input.name]: template,
      },
    }));

    return template;
  }

  async getRuntimeTemplatesSnapshot(): Promise<{
    version: number;
    templatesHash: string;
    templates: Record<
      string,
      { content: string; writeMode: "seed" | "inject" }
    >;
    createdAt: string;
  }> {
    const templates = (await this.listTemplates()).filter(
      (template) => template.status === "active",
    );
    const payload = Object.fromEntries(
      templates.map((template) => [
        template.name,
        {
          content: template.content,
          writeMode: template.writeMode,
        },
      ]),
    );
    const createdAt = now();
    return {
      version: templates.length,
      templatesHash: crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      templates: payload,
      createdAt,
    };
  }
}
