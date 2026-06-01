const PLUGIN_ID = "clawpi-image-generation";
const DEFAULT_CONTROLLER_URL = "http://127.0.0.1:3010";
const CONTROLLER_FETCH_TIMEOUT_MS = 190_000;
const CONTROLLER_FETCH_RETRY_DELAYS_MS = [500, 1_500, 3_000];

const IMAGE_TOOL_PROMPT =
  "Use image_generate for image generation and image editing requests. If reference image paths, URLs, or data URLs are provided, pass them through inputImages. For image-to-image/edit requests based on an uploaded or visible image, never call image_generate with empty inputImages; if no usable image path/URL/data URL is available, ask for a local path or upload through the Claw-Pi workbench attachment flow. If image_generate returns a transient upstream or network error, do not invent quota/limit protection unless the tool error explicitly says balance, quota, or rate limit. After a successful tool call, include the generated image markdown from the tool result in web/workbench final replies so the client can render the image. In messaging channels such as WeChat, prefer sending attached media directly instead of only describing a link.";

function getPluginConfig(api) {
  const entry = api?.config?.plugins?.entries?.[PLUGIN_ID];
  const config = entry && typeof entry === "object" ? entry.config : null;
  return config && typeof config === "object" ? config : {};
}

function getControllerUrl(api) {
  const config = getPluginConfig(api);
  const configured =
    typeof config.controllerUrl === "string" ? config.controllerUrl.trim() : "";
  const fromEnv =
    typeof process.env.NEXU_CONTROLLER_URL === "string"
      ? process.env.NEXU_CONTROLLER_URL.trim()
      : "";
  return (configured || fromEnv || DEFAULT_CONTROLLER_URL).replace(/\/+$/u, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryLocalControllerFetch(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|socket|connection|econnreset|econnrefused|etimedout|eai_again|enotfound|aborted|timeout|timed out/i.test(
    message,
  );
}

async function fetchControllerWithRetries(url, init, api) {
  let retryIndex = 0;

  while (true) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (
        init?.signal?.aborted ||
        retryIndex >= CONTROLLER_FETCH_RETRY_DELAYS_MS.length ||
        !shouldRetryLocalControllerFetch(error)
      ) {
        throw error;
      }

      const retryDelay = CONTROLLER_FETCH_RETRY_DELAYS_MS[retryIndex] ?? 0;
      retryIndex += 1;
      api?.logger?.warn?.(
        `[clawpi-image-generation] controller fetch retry ${retryIndex}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await delay(retryDelay);
    }
  }
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    ...(details ? { details } : {}),
  };
}

function sanitizeInputImages(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function looksLikeImageToImageRequest(input) {
  const text = [
    typeof input.prompt === "string" ? input.prompt : "",
    typeof input.mode === "string" ? input.mode : "",
    typeof input.task === "string" ? input.task : "",
  ]
    .join("\n")
    .toLowerCase();

  return /(?:uploaded|attached|reference|source|input image|image-to-image|img2img|edit image|based on (?:the|this) image|use (?:the|this) image|参考图|参考图片|上传图|上传图片|附件图|原图|这张图|这张图片|基于.*图|按照.*图|图生图|改图|修图|换背景|图片编辑|参考.*风格)/iu.test(
    text,
  );
}

function logToolCall(api, details) {
  api?.logger?.info?.(
    `[clawpi-image-generation] tool_call ${JSON.stringify(details)}`,
  );
}

const ImageGenerateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: {
      type: "string",
      description:
        "Required. A concise, visual prompt for the image to generate. Include style, subject, composition, aspect ratio, and any text that should appear in the image.",
    },
    aspectRatio: {
      type: "string",
      description:
        "Optional. One of 1:1, 16:9, 9:16, landscape, portrait, or square. Use this when the user mentions orientation.",
    },
    size: {
      type: "string",
      description:
        "Optional exact image size, for example 1024x1024, 1536x1024, or 1024x1536.",
    },
    modelId: {
      type: "string",
      description:
        "Optional Claw-Pi image model id. Usually omit this so Claw-Pi uses the user's default image model.",
    },
    inputImages: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional reference image URLs, data URLs, or absolute local file paths for image-to-image/edit requests.",
    },
    mode: {
      type: "string",
      description:
        "Optional. Set to image_to_image or edit when the request depends on a reference/uploaded image.",
    },
  },
  required: ["prompt"],
};

const plugin = {
  id: PLUGIN_ID,
  name: "Claw-Pi Image Generation",
  description:
    "Provides an image_generate tool backed by the user's selected Claw-Pi image model.",
  register(api) {
    api.on?.("before_prompt_build", async () => ({
      prependSystemContext: IMAGE_TOOL_PROMPT,
    }));

    api.registerTool(
      {
        name: "image_generate",
        label: "Generate image",
        description:
          "Generate an actual image file through Claw-Pi. Use this whenever the user asks for image generation, drawing, illustration, poster/product image creation, image editing, image-to-image, or says things like '给我图片', '生图', '画一张', '做图'. Do not answer with only a prompt when this tool can be used.",
        parameters: ImageGenerateSchema,
        async execute(_toolCallId, params) {
          const input = params && typeof params === "object" ? params : {};
          const prompt =
            typeof input.prompt === "string" ? input.prompt.trim() : "";
          if (!prompt) {
            return textResult("生图失败：缺少 prompt 参数。");
          }

          const inputImages = sanitizeInputImages(input.inputImages);
          const requiresInputImage = looksLikeImageToImageRequest(input);
          logToolCall(api, {
            promptChars: prompt.length,
            inputImagesCount: inputImages.length,
            requiresInputImage,
            hasAspectRatio:
              typeof input.aspectRatio === "string" &&
              input.aspectRatio.trim().length > 0,
            hasSize:
              typeof input.size === "string" && input.size.trim().length > 0,
            requestedModelId:
              typeof input.modelId === "string" && input.modelId.trim()
                ? input.modelId.trim()
                : null,
          });

          if (requiresInputImage && inputImages.length === 0) {
            return textResult(
              "生图失败：这看起来是基于上传/参考图片的图生图或改图请求，但 image_generate 没有收到可用的 inputImages。请通过龙虾工作台附件上传，或提供本机图片路径/图片 URL 后再试；本次没有提交生图请求。",
              {
                code: "missing_input_images",
                requiresInputImage: true,
                inputImagesCount: 0,
              },
            );
          }

          const body = {
            prompt,
            ...(typeof input.aspectRatio === "string" &&
            input.aspectRatio.trim()
              ? { aspectRatio: input.aspectRatio.trim() }
              : {}),
            ...(typeof input.size === "string" && input.size.trim()
              ? { size: input.size.trim() }
              : {}),
            ...(typeof input.modelId === "string" && input.modelId.trim()
              ? { modelId: input.modelId.trim() }
              : {}),
            inputImages,
          };

          let response;
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            CONTROLLER_FETCH_TIMEOUT_MS,
          );
          try {
            response = await fetchControllerWithRetries(
              `${getControllerUrl(api)}/api/internal/desktop/images/generations`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
              },
              api,
            );
          } catch (error) {
            return textResult(
              `生图失败：无法连接 Claw-Pi Controller（${error instanceof Error ? error.message : String(error)}）。`,
            );
          } finally {
            clearTimeout(timeoutId);
          }

          const rawText = await response.text();
          let data;
          try {
            data = rawText ? JSON.parse(rawText) : null;
          } catch {
            data = null;
          }

          if (!response.ok || !data?.ok) {
            const message =
              data?.error || rawText || `HTTP ${response.status}`;
            return textResult(`生图失败：${message}`);
          }

          const resultText =
            typeof data.markdown === "string" && data.markdown.trim()
              ? `图片已生成。\n${data.markdown.trim()}`
              : typeof data.url === "string" && data.url.trim()
                ? `图片已生成。\n${data.url.trim()}`
                : "图片已生成。";

          const mediaUrls = [data.url].filter(
            (value) => typeof value === "string" && value.trim(),
          );

          return textResult(resultText, {
            id: data.id,
            modelId: data.modelId,
            url: data.url,
            mediaUrl: mediaUrls[0],
            mediaUrls,
            filePath: data.filePath,
            path: data.filePath,
            mimeType: data.mimeType,
            markdown: data.markdown,
            durationMs: data.durationMs,
            media: {
              mediaUrl: mediaUrls[0],
              mediaUrls,
              filePath: data.filePath,
              mimeType: data.mimeType,
            },
          });
        },
      },
      { name: "image_generate" },
    );

    api.logger?.info?.("[clawpi-image-generation] Registered image_generate tool");
  },
};

export default plugin;
