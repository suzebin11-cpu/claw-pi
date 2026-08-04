export type DesktopCloudModel = {
  id: string;
  name: string;
  provider?: string;
};

export type DesktopCloudImageModel = DesktopCloudModel & {
  runtimeModelId: string;
};

/**
 * Models that are part of the Claw-Pi cloud contract even when the remote
 * `/v1/models` discovery request is temporarily unavailable.
 *
 * Keep this list deliberately small: entries are only merged for an active
 * desktop cloud session with an API key, so disconnected users never see a
 * model they cannot call. GPT-5.6 is a display-only alias of this backing model
 * in the web app and therefore does not belong in the runtime catalog itself.
 */
export const BUILT_IN_DESKTOP_CLOUD_CHAT_MODELS: readonly DesktopCloudModel[] =
  [
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
    },
  ];

export const DESKTOP_CLOUD_IMAGE_PROVIDER_ID = "clawpi-image";
export const DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID = `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/gpt-image-2`;

export const BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS: readonly DesktopCloudImageModel[] =
  [
    {
      id: "gpt-image-1-mini",
      name: "GPT Image 1 Mini",
      provider: "openai",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/gpt-image-1-mini`,
    },
    {
      id: "gpt-image-1.5",
      name: "GPT Image 1.5",
      provider: "openai",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/gpt-image-1.5`,
    },
    {
      id: "gpt-image-2",
      name: "GPT Image 2",
      provider: "openai",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/gpt-image-2`,
    },
    {
      id: "doubao-seedream-4-0-250828",
      name: "Doubao Seedream 4.0",
      provider: "doubao",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/doubao-seedream-4-0-250828`,
    },
    {
      id: "doubao-seedream-4-5-251128",
      name: "Doubao Seedream 4.5",
      provider: "doubao",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/doubao-seedream-4-5-251128`,
    },
    {
      id: "doubao-seedream-5-0-260128",
      name: "Doubao Seedream 5.0 Lite",
      provider: "doubao",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/doubao-seedream-5-0-260128`,
    },
    {
      id: "qwen-image-max",
      name: "Qwen Image Max",
      provider: "qwen",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/qwen-image-max`,
    },
    {
      id: "z-image-turbo",
      name: "Z-Image Turbo",
      provider: "zimage",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/z-image-turbo`,
    },
    {
      id: "flux.1-kontext-pro",
      name: "FLUX.1 Kontext Pro",
      provider: "flux",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/flux.1-kontext-pro`,
    },
    {
      id: "grok-imagine-image-pro",
      name: "Grok Imagine Image Pro",
      provider: "grok",
      runtimeModelId: `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/grok-imagine-image-pro`,
    },
  ];

export function normalizeDesktopCloudImageModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.startsWith(`${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/`)) {
    return trimmed;
  }
  const bareId = trimmed.includes("/") ? trimmed.split("/").pop() : trimmed;
  const known = BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS.find(
    (model) => model.id === bareId,
  );
  return known?.runtimeModelId ?? trimmed;
}

export function isBuiltInDesktopCloudImageModel(modelId: string): boolean {
  const normalized = normalizeDesktopCloudImageModelId(modelId);
  return BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS.some(
    (model) => model.runtimeModelId === normalized,
  );
}

export function normalizeDesktopCloudModels(
  models: readonly DesktopCloudModel[] | undefined,
): DesktopCloudModel[] {
  const byId = new Map<string, DesktopCloudModel>();
  for (const model of models ?? []) {
    byId.set(model.id, model);
  }
  return [...byId.values()];
}

export function withBuiltInDesktopCloudChatModels(
  models: readonly DesktopCloudModel[] | undefined,
): DesktopCloudModel[] {
  const normalized = normalizeDesktopCloudModels(models);
  const discoveredIds = new Set(normalized.map((model) => model.id));
  return normalizeDesktopCloudModels([
    ...normalized,
    ...BUILT_IN_DESKTOP_CLOUD_CHAT_MODELS.filter(
      (model) => !discoveredIds.has(model.id),
    ),
  ]);
}
