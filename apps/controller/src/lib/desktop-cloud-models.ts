export type DesktopCloudModel = {
  id: string;
  name: string;
  provider?: string;
};

export type DesktopCloudImageModel = DesktopCloudModel & {
  runtimeModelId: string;
};

export const DESKTOP_CLOUD_IMAGE_PROVIDER_ID = "clawpi-image";

export const BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS: readonly DesktopCloudImageModel[] =
  [];

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
