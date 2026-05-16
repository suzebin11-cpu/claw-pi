export type DesktopCloudModel = {
  id: string;
  name: string;
  provider?: string;
};

export type DesktopCloudImageModel = DesktopCloudModel & {
  runtimeModelId: string;
};

export const DESKTOP_CLOUD_IMAGE_PROVIDER_ID = "clawpi-image";
export const DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID = `${DESKTOP_CLOUD_IMAGE_PROVIDER_ID}/gpt-image-1-mini`;

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
