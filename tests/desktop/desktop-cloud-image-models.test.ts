import { describe, expect, it } from "vitest";
import {
  BUILT_IN_DESKTOP_CLOUD_CHAT_MODELS,
  BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS,
  DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID,
  isBuiltInDesktopCloudImageModel,
  normalizeDesktopCloudImageModelId,
  withBuiltInDesktopCloudChatModels,
} from "#controller/lib/desktop-cloud-models";

describe("desktop cloud chat models", () => {
  it("keeps GPT-5.5 available when remote discovery is empty", () => {
    expect(withBuiltInDesktopCloudChatModels([])).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
      },
    ]);
    expect(BUILT_IN_DESKTOP_CLOUD_CHAT_MODELS).toHaveLength(1);
  });

  it("preserves discovered metadata and ordering", () => {
    expect(
      withBuiltInDesktopCloudChatModels([
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
        { id: "gpt-5.5", name: "GPT-5.5 Fast", provider: "clawpi" },
      ]),
    ).toEqual([
      { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      { id: "gpt-5.5", name: "GPT-5.5 Fast", provider: "clawpi" },
    ]);
  });
});

describe("desktop cloud image models", () => {
  it("uses GPT Image 2 as the default image model", () => {
    expect(DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID).toBe(
      "clawpi-image/gpt-image-2",
    );
    expect(
      isBuiltInDesktopCloudImageModel(DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID),
    ).toBe(true);
  });

  it("normalizes bare cloud image model ids to runtime model ids", () => {
    expect(normalizeDesktopCloudImageModelId("gpt-image-2")).toBe(
      "clawpi-image/gpt-image-2",
    );
    expect(
      normalizeDesktopCloudImageModelId("clawpi-image/gpt-image-1-mini"),
    ).toBe("clawpi-image/gpt-image-1-mini");
  });

  it("keeps the built-in image model list curated", () => {
    expect(
      BUILT_IN_DESKTOP_CLOUD_IMAGE_MODELS.map((model) => model.id),
    ).toEqual([
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "gpt-image-2",
      "doubao-seedream-4-0-250828",
      "doubao-seedream-4-5-251128",
      "doubao-seedream-5-0-260128",
      "qwen-image-max",
      "z-image-turbo",
      "flux.1-kontext-pro",
      "grok-imagine-image-pro",
    ]);
  });
});
