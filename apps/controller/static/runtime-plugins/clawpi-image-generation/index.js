const PLUGIN_ID = "clawpi-image-generation";
const DEFAULT_CONTROLLER_URL = "http://127.0.0.1:3010";

const IMAGE_TOOL_PROMPT =
  "Claw-Pi can generate images through the image_generate tool. When the user asks to generate, create, draw, render, edit, or remake an image, call image_generate instead of saying you cannot generate images. After the tool returns, give a short confirmation only. The tool result carries the generated image as structured media, so never reply with raw image URLs, local file paths, or markdown image links. In messaging channels such as WeChat, send the attached media directly instead of describing a link.";

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
            inputImages: sanitizeInputImages(input.inputImages),
          };

          let response;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 190_000);
          try {
            response = await fetch(
              `${getControllerUrl(api)}/api/internal/desktop/images/generations`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
              },
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

          const resultText = [
            "图片已生成，生成的图片已经作为媒体附件附加到本次工具结果。",
            "不要把图片地址、本地文件路径或 markdown 图片链接发给用户；直接让客户端展示附件即可。",
          ].join("\n");

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
