import crypto from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ControllerEnv } from "../app/env.js";
import {
  DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID,
  isBuiltInDesktopCloudImageModel,
  normalizeDesktopCloudImageModelId,
} from "../lib/desktop-cloud-models.js";
import { logger } from "../lib/logger.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";

type ImageFetch = (
  input: string | URL,
  options?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

type ImageGenerationOptions = {
  fetchImpl?: ImageFetch;
};

type DesktopCloudImageSettings = {
  connected: boolean;
  linkUrl: string;
  apiKey: string | null;
  modelId: string;
};

export type GenerateImageInput = {
  prompt: string;
  modelId?: string | null;
  size?: string | null;
  aspectRatio?: string | null;
  inputImages?: string[] | null;
};

export type GeneratedImageResult = {
  id: string;
  modelId: string;
  prompt: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  url: string;
  markdown: string;
  durationMs: number;
};

type OpenAiImageResponse = {
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
  };
};

const DEFAULT_IMAGE_SIZE = "1024x1024";
const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const IMAGE_GENERATION_RETRY_DELAYS_MS = [1_500, 3_000] as const;
const MAX_INPUT_IMAGES = 4;
const MAX_PROMPT_CHARS = 4000;

function getGeneratedImagesDir(env: ControllerEnv): string {
  return path.join(env.nexuHomeDir, "generated-images");
}

function getControllerBaseUrl(env: ControllerEnv): string {
  return `http://127.0.0.1:${env.port}`;
}

function normalizeImageModelId(modelId: string | null | undefined): string {
  const normalized = normalizeDesktopCloudImageModelId(
    modelId?.trim() || DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID,
  );
  if (!isBuiltInDesktopCloudImageModel(normalized)) {
    throw new Error(`当前不支持生图模型 ${normalized}`);
  }
  return normalized;
}

function runtimeModelIdToCloudModelId(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
}

function normalizeSize(input: GenerateImageInput): string {
  const rawSize = input.size?.trim();
  if (rawSize) return rawSize;

  switch (input.aspectRatio?.trim()) {
    case "landscape":
    case "16:9":
    case "3:2":
      return "1536x1024";
    case "portrait":
    case "9:16":
    case "2:3":
      return "1024x1536";
    case "1:1":
    case "square":
    default:
      return DEFAULT_IMAGE_SIZE;
  }
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

function mimeTypeFromPath(input: string): string {
  const ext = path.extname(input).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function isHttpUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

function parseDataUrl(input: string): { bytes: Buffer; mimeType: string } {
  const match = input.match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) {
    throw new Error("不支持的 data URL 图片格式");
  }
  return {
    mimeType: match[1] ?? "image/png",
    bytes: Buffer.from(match[2] ?? "", "base64"),
  };
}

function parseImageResponse(
  payload: OpenAiImageResponse,
): { b64Json?: string; url?: string } {
  const first = payload.data?.[0];
  if (!first) {
    const message = payload.error?.message ?? "生图接口没有返回图片";
    throw new Error(message);
  }

  if (first.b64_json) {
    return { b64Json: first.b64_json };
  }

  if (first.url) {
    return { url: first.url };
  }

  throw new Error("生图接口返回格式不包含 url 或 b64_json");
}

async function readResponseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return `HTTP ${response.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function shouldRetryWithoutResponseFormat(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("response_format") &&
    (/unknown|unsupported|unrecognized|invalid|not support/u.test(
      normalized,
    ) ||
      /不支持|未知|无效|不允许/u.test(message))
  );
}

function shouldRetryTransientImageError(
  status: number | null,
  message: string,
): boolean {
  if (status !== null && [408, 429, 502, 503, 504].includes(status)) {
    return true;
  }

  return /overloaded|rate limit|too many|temporar|timeout|timed out|busy|queue|upstream|econnreset|etimedout|限流|负载|繁忙|饱和|排队|超时|稍后再试/u.test(
    message.toLowerCase(),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchImageBytes(
  fetchImpl: ImageFetch,
  imageUrl: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await fetchImpl(imageUrl);
  if (!response.ok) {
    throw new Error(`下载生成图片失败: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "image/png";
  return {
    mimeType: contentType.split(";")[0]?.trim() || "image/png",
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

async function buildInputImageBlob(
  fetchImpl: ImageFetch,
  input: string,
): Promise<{ blob: Blob; fileName: string }> {
  if (input.startsWith("data:")) {
    const parsed = parseDataUrl(input);
    return {
      blob: new Blob([parsed.bytes], { type: parsed.mimeType }),
      fileName: `reference.${extensionFromMimeType(parsed.mimeType)}`,
    };
  }

  if (isHttpUrl(input)) {
    const fetched = await fetchImageBytes(fetchImpl, input);
    const urlPath = new URL(input).pathname;
    const baseName = path.basename(urlPath) || "reference";
    return {
      blob: new Blob([fetched.bytes], { type: fetched.mimeType }),
      fileName: baseName.includes(".")
        ? baseName
        : `${baseName}.${extensionFromMimeType(fetched.mimeType)}`,
    };
  }

  const bytes = await readFile(input);
  const mimeType = mimeTypeFromPath(input);
  return {
    blob: new Blob([bytes], { type: mimeType }),
    fileName: path.basename(input) || `reference.${extensionFromMimeType(mimeType)}`,
  };
}

export class ImageGenerationService {
  private readonly fetchImpl: ImageFetch;

  constructor(
    private readonly configStore: NexuConfigStore,
    private readonly env: ControllerEnv,
    options: ImageGenerationOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? proxyFetch;
  }

  async generateImage(input: GenerateImageInput): Promise<GeneratedImageResult> {
    const startedAt = Date.now();
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("生图提示词不能为空");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`生图提示词不能超过 ${MAX_PROMPT_CHARS} 个字符`);
    }

    const settings = await this.getImageSettings(input.modelId);
    if (!settings.connected || !settings.apiKey) {
      throw new Error("Claw-Pi 官方服务尚未连接，无法生成图片");
    }

    const inputImages = (input.inputImages ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_INPUT_IMAGES);

    const cloudModelId = runtimeModelIdToCloudModelId(settings.modelId);
    const size = normalizeSize(input);
    const payload = inputImages.length > 0
      ? await this.callImageEdit({
          settings,
          modelId: cloudModelId,
          prompt,
          size,
          inputImages,
        })
      : await this.callImageGeneration({
          settings,
          modelId: cloudModelId,
          prompt,
          size,
        });

    const generated = parseImageResponse(payload);
    const image =
      generated.b64Json !== undefined
        ? {
            bytes: Buffer.from(generated.b64Json, "base64"),
            mimeType: "image/png",
          }
        : await fetchImageBytes(this.fetchImpl, generated.url!);

    const result = await this.saveImage({
      bytes: image.bytes,
      mimeType: image.mimeType,
      modelId: settings.modelId,
      prompt,
      startedAt,
    });

    logger.info(
      {
        modelId: settings.modelId,
        durationMs: result.durationMs,
        hasInputImages: inputImages.length > 0,
      },
      "image_generation_completed",
    );

    return result;
  }

  private async callImageEndpointWithRetries(params: {
    label: string;
    buildRequest: (
      includeResponseFormat: boolean,
    ) =>
      | Promise<{ url: string; init: RequestInit & { timeoutMs: number } }>
      | { url: string; init: RequestInit & { timeoutMs: number } };
  }): Promise<OpenAiImageResponse> {
    let includeResponseFormat = true;
    let retryIndex = 0;

    while (true) {
      const request = await params.buildRequest(includeResponseFormat);
      let response: Response;

      try {
        response = await this.fetchImpl(request.url, request.init);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          retryIndex < IMAGE_GENERATION_RETRY_DELAYS_MS.length &&
          shouldRetryTransientImageError(null, message)
        ) {
          const retryDelay = IMAGE_GENERATION_RETRY_DELAYS_MS[retryIndex] ?? 0;
          retryIndex += 1;
          logger.warn(
            { label: params.label, retryIndex, retryDelay, errorMessage: message },
            "image_generation_network_retry",
          );
          await delay(retryDelay);
          continue;
        }
        throw new Error(message);
      }

      if (response.ok) {
        return (await response.json()) as OpenAiImageResponse;
      }

      const message = await readResponseError(response);
      if (includeResponseFormat && shouldRetryWithoutResponseFormat(message)) {
        includeResponseFormat = false;
        logger.warn(
          { label: params.label, status: response.status, errorMessage: message },
          "image_generation_retry_without_response_format",
        );
        continue;
      }

      if (
        retryIndex < IMAGE_GENERATION_RETRY_DELAYS_MS.length &&
        shouldRetryTransientImageError(response.status, message)
      ) {
        const retryDelay = IMAGE_GENERATION_RETRY_DELAYS_MS[retryIndex] ?? 0;
        retryIndex += 1;
        logger.warn(
          {
            label: params.label,
            status: response.status,
            retryIndex,
            retryDelay,
            errorMessage: message,
          },
          "image_generation_transient_retry",
        );
        await delay(retryDelay);
        continue;
      }

      throw new Error(message);
    }
  }

  private async getImageSettings(
    requestedModelId: string | null | undefined,
  ): Promise<DesktopCloudImageSettings> {
    const config = await this.configStore.getConfig();
    const desktop = config.desktop as Record<string, unknown>;
    const cloud =
      typeof desktop.cloud === "object" && desktop.cloud !== null
        ? (desktop.cloud as Record<string, unknown>)
        : {};

    const status = await this.configStore.getDesktopCloudStatus();
    const configuredModelId =
      requestedModelId ??
      config.runtime.defaultImageGenerationModelId ??
      DEFAULT_DESKTOP_CLOUD_IMAGE_MODEL_ID;

    return {
      connected: cloud.connected === true,
      linkUrl:
        (typeof cloud.linkUrl === "string" && cloud.linkUrl.trim()) ||
        status.linkUrl,
      apiKey:
        (typeof cloud.apiKey === "string" && cloud.apiKey.trim()) || null,
      modelId: normalizeImageModelId(configuredModelId),
    };
  }

  private async callImageGeneration(params: {
    settings: DesktopCloudImageSettings;
    modelId: string;
    prompt: string;
    size: string;
  }): Promise<OpenAiImageResponse> {
    const endpoint = `${params.settings.linkUrl.replace(/\/+$/u, "")}/v1/images/generations`;

    return this.callImageEndpointWithRetries({
      label: "generations",
      buildRequest: (includeResponseFormat) => ({
        url: endpoint,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.settings.apiKey}`,
          },
          body: JSON.stringify({
            model: params.modelId,
            prompt: params.prompt,
            n: 1,
            size: params.size,
            ...(includeResponseFormat ? { response_format: "b64_json" } : {}),
          }),
          timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
        } as RequestInit & { timeoutMs: number },
      }),
    });
  }

  private async callImageEdit(params: {
    settings: DesktopCloudImageSettings;
    modelId: string;
    prompt: string;
    size: string;
    inputImages: string[];
  }): Promise<OpenAiImageResponse> {
    const endpoint = `${params.settings.linkUrl.replace(/\/+$/u, "")}/v1/images/edits`;

    return this.callImageEndpointWithRetries({
      label: "edits",
      buildRequest: async (includeResponseFormat) => {
        const form = new FormData();
        form.set("model", params.modelId);
        form.set("prompt", params.prompt);
        form.set("n", "1");
        form.set("size", params.size);
        if (includeResponseFormat) {
          form.set("response_format", "b64_json");
        }

        for (const inputImage of params.inputImages) {
          const image = await buildInputImageBlob(this.fetchImpl, inputImage);
          form.append("image", image.blob, image.fileName);
        }

        return {
          url: endpoint,
          init: {
            method: "POST",
            headers: {
              Authorization: `Bearer ${params.settings.apiKey}`,
            },
            body: form,
            timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
          } as RequestInit & { timeoutMs: number },
        };
      },
    });
  }

  private async saveImage(params: {
    bytes: Buffer;
    mimeType: string;
    modelId: string;
    prompt: string;
    startedAt: number;
  }): Promise<GeneratedImageResult> {
    const id = crypto.randomUUID();
    const extension = extensionFromMimeType(params.mimeType);
    const fileName = `${id}.${extension}`;
    const dir = getGeneratedImagesDir(this.env);
    const filePath = path.join(dir, fileName);
    const url = `${getControllerBaseUrl(this.env)}/api/internal/desktop/generated-images/${fileName}`;

    await mkdir(dir, { recursive: true });
    await writeFile(filePath, params.bytes);

    const markdown = `![生成图片](${url})`;
    return {
      id,
      modelId: params.modelId,
      prompt: params.prompt,
      fileName,
      filePath,
      mimeType: params.mimeType,
      url,
      markdown,
      durationMs: Date.now() - params.startedAt,
    };
  }

  async readGeneratedImage(fileName: string): Promise<{
    bytes: Buffer;
    mimeType: string;
  } | null> {
    if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp|gif)$/iu.test(fileName)) {
      return null;
    }

    const dir = getGeneratedImagesDir(this.env);
    const filePath = path.resolve(dir, fileName);
    const resolvedDir = path.resolve(dir);
    if (!filePath.startsWith(`${resolvedDir}${path.sep}`)) {
      return null;
    }

    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        return null;
      }
      return {
        bytes: await readFile(filePath),
        mimeType: mimeTypeFromPath(filePath),
      };
    } catch {
      return null;
    }
  }
}
