import { describe, expect, it } from "vitest";
import {
  BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS,
  DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID,
  isBuiltInDesktopCloudImageModel,
  normalizeDesktopCloudImageModelId,
} from "#controller/lib/desktop-cloud-models";

describe("desktop cloud image models", () => {
  it("uses gpt-image-1-mini as the low-cost default image model", () => {
    expect(DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID).toBe(
      "clawpi-image/gpt-image-1-mini",
    );
    expect(isBuiltInDesktopCloudImageModel(DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID))
      .toBe(true);
  });

  it("normalizes bare cloud image model ids to runtime model ids", () => {
    expect(normalizeDesktopCloudImageModelId("gpt-image-2")).toBe(
      "clawpi-image/gpt-image-2",
    );
    expect(normalizeDesktopCloudImageModelId("clawpi-image/gpt-image-1-mini"))
      .toBe("clawpi-image/gpt-image-1-mini");
  });

  it("keeps the built-in image model list intentionally small", () => {
    expect(BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS.map((model) => model.id))
      .toEqual([
        "gpt-image-1-mini",
        "gpt-image-1.5",
        "gpt-image-2",
        "doubao-seedream-4-0-250828",
      ]);
  });
});
