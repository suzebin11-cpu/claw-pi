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
const IMAGE_DOWNLOAD_TIMEOUT_MS = 90_000;
const IMAGE_GENERATION_RETRY_DELAYS_MS = [1_500, 3_000] as const;
const MAX_INPUT_IMAGES = 4;
const MAX_PROMPT_CHARS = 4000;
const INSUFFICIENT_BALANCE_MESSAGE = "余额不足，请及时充值";
const IMAGE_RESPONSE_LOST_MESSAGE =
  "图片生成请求可能已提交，但本地未收到图片结果；为避免重复扣费，已停止自动重试。";

type ImageEndpointLabel = "generations" | "edits";

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

function summarizeImageEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "image endpoint";
  }
}

function readPrimitiveProperty(
  value: unknown,
  key: string,
): string | number | boolean | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  if (
    typeof property === "string" ||
    typeof property === "number" ||
    typeof property === "boolean"
  ) {
    return property;
  }
  return undefined;
}

function readErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function buildImageFetchErrorDetails(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const details: Record<string, unknown> = {
    errorMessage: message,
  };

  if (error instanceof Error) {
    details.errorName = error.name;
  }

  const errorCode = readPrimitiveProperty(error, "code");
  if (errorCode !== undefined) {
    details.errorCode = errorCode;
  }

  const cause = readErrorCause(error);
  if (cause instanceof Error) {
    details.causeName = cause.name;
    details.causeMessage = cause.message;
  } else if (cause !== undefined) {
    details.causeMessage = String(cause);
  }

  for (const key of ["code", "errno", "syscall"] as const) {
    const value = readPrimitiveProperty(cause, key);
    if (value !== undefined) {
      details[`cause${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value;
    }
  }

  return details;
}

function normalizeSize(input: GenerateImageInput): string {
  const rawSize = input.size?.trim();
  if (rawSize) return rawSize;

  const aspectRatio = input.aspectRatio?.trim();
  if (aspectRatio === "1:1" || aspectRatio === "square") {
    return DEFAULT_IMAGE_SIZE;
  }

  switch (aspectRatio) {
    case "landscape":
    case "16:9":
    case "3:2":
      return "1536x1024";
    case "portrait":
    case "9:16":
    case "2:3":
      return "1024x1536";
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

function parseImageResponse(payload: OpenAiImageResponse): {
  b64Json?: string;
  url?: string;
} {
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
    (/unknown|unsupported|unrecognized|invalid|not support/u.test(normalized) ||
      /不支持|未知|无效|不允许/u.test(message))
  );
}

function isImageSafetyRejection(message: string): boolean {
  return /safety system|content policy|content moderation|policy violation|unsafe|安全系统|安全策略|内容审核|风控|违规/u.test(
    message.toLowerCase(),
  );
}

function isInsufficientBalanceError(message: string): boolean {
  return /(?:token quota is not enough|need quota|insufficient (?:balance|quota|credits?)|quota.+not enough|余额不足|额度不足|余额不够|充值)/iu.test(
    message,
  );
}

function isImageNetworkError(message: string): boolean {
  return (
    /^(?:fetch failed|network error)$/iu.test(message.trim()) ||
    /(?:socket|connection|econnreset|econnrefused|etimedout|eai_again|enotfound|network|fetch failed|网络|连接失败|连接中断)/iu.test(
      message,
    )
  );
}

export function normalizeImageGenerationErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (isInsufficientBalanceError(trimmed)) {
    return INSUFFICIENT_BALANCE_MESSAGE;
  }
  if (/timed out|timeout|超时/iu.test(trimmed)) {
    return IMAGE_RESPONSE_LOST_MESSAGE;
  }
  if (isImageNetworkError(trimmed)) {
    return IMAGE_RESPONSE_LOST_MESSAGE;
  }
  return trimmed || "图片生成失败，请稍后重试";
}

function shouldRetryTransientImageError(
  status: number | null,
  message: string,
): boolean {
  if (isImageSafetyRejection(message)) {
    return false;
  }

  if (status !== null && [408, 429, 502, 503, 504].includes(status)) {
    return true;
  }

  return /fetch failed|network|socket|connection|aborted|overloaded|rate limit|too many|temporar|timeout|timed out|busy|queue|upstream|econnreset|econnrefused|etimedout|eai_again|enotfound|限流|负载|繁忙|饱和|排队|超时|网络|连接|稍后再试/u.test(
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
  let retryIndex = 0;

  while (true) {
    try {
      const response = await fetchImpl(imageUrl, {
        timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
      });
      if (!response.ok) {
        const message = `下载生成图片失败: HTTP ${response.status}`;
        if (
          retryIndex < IMAGE_GENERATION_RETRY_DELAYS_MS.length &&
          shouldRetryTransientImageError(response.status, message)
        ) {
          const retryDelay = IMAGE_GENERATION_RETRY_DELAYS_MS[retryIndex] ?? 0;
          retryIndex += 1;
          logger.warn(
            { retryIndex, retryDelay, status: response.status },
            "image_download_transient_retry",
          );
          await delay(retryDelay);
          continue;
        }
        throw new Error(message);
      }
      const contentType = response.headers.get("content-type") ?? "image/png";
      return {
        mimeType: contentType.split(";")[0]?.trim() || "image/png",
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        retryIndex < IMAGE_GENERATION_RETRY_DELAYS_MS.length &&
        shouldRetryTransientImageError(null, message)
      ) {
        const retryDelay = IMAGE_GENERATION_RETRY_DELAYS_MS[retryIndex] ?? 0;
        retryIndex += 1;
        logger.warn(
          { retryIndex, retryDelay, errorMessage: message },
          "image_download_network_retry",
        );
        await delay(retryDelay);
        continue;
      }
      throw error;
    }
  }
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
    fileName:
      path.basename(input) || `reference.${extensionFromMimeType(mimeType)}`,
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

  async generateImage(
    input: GenerateImageInput,
  ): Promise<GeneratedImageResult> {
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
    const payload =
      inputImages.length > 0
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
    const generatedUrl = generated.url;
    if (generated.b64Json === undefined && !generatedUrl) {
      throw new Error("生图接口返回格式不包含 url 或 b64_json");
    }
    const image =
      generated.b64Json !== undefined
        ? {
            bytes: Buffer.from(generated.b64Json, "base64"),
            mimeType: "image/png",
          }
        : await fetchImageBytes(this.fetchImpl, generatedUrl ?? "");

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
    label: ImageEndpointLabel;
    modelId: string;
    hasInputImages: boolean;
    inputImageCount: number;
    buildRequest: (
      includeResponseFormat: boolean,
    ) =>
      | Promise<{ url: string; init: RequestInit & { timeoutMs: number } }>
      | { url: string; init: RequestInit & { timeoutMs: number } };
  }): Promise<OpenAiImageResponse> {
    let includeResponseFormat = false;

    while (true) {
      const request = await params.buildRequest(includeResponseFormat);
      let response: Response;
      let elapsedMs = 0;

      try {
        const result = await this.fetchImageCloudEndpoint({
          label: params.label,
          modelId: params.modelId,
          hasInputImages: params.hasInputImages,
          inputImageCount: params.inputImageCount,
          includeResponseFormat,
          url: request.url,
          init: request.init,
        });
        response = result.response;
        elapsedMs = result.elapsedMs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(normalizeImageGenerationErrorMessage(message));
      }

      if (response.ok) {
        return (await response.json()) as OpenAiImageResponse;
      }

      const message = await readResponseError(response);
      if (includeResponseFormat && shouldRetryWithoutResponseFormat(message)) {
        includeResponseFormat = false;
        logger.warn(
          {
            label: params.label,
            modelId: params.modelId,
            hasInputImages: params.hasInputImages,
            inputImageCount: params.inputImageCount,
            status: response.status,
            elapsedMs,
            errorMessage: message,
          },
          "image_generation_retry_without_response_format",
        );
        continue;
      }

      logger.warn(
        {
          label: params.label,
          modelId: params.modelId,
          hasInputImages: params.hasInputImages,
          inputImageCount: params.inputImageCount,
          status: response.status,
          elapsedMs,
          errorMessage: message,
        },
        "image_generation_failed",
      );
      throw new Error(normalizeImageGenerationErrorMessage(message));
    }
  }

  private async fetchImageCloudEndpoint(params: {
    label: ImageEndpointLabel;
    modelId: string;
    hasInputImages: boolean;
    inputImageCount: number;
    includeResponseFormat: boolean;
    url: string;
    init: RequestInit & { timeoutMs: number };
  }): Promise<{ response: Response; elapsedMs: number }> {
    const startedAt = Date.now();
    const baseDetails = {
      label: params.label,
      endpoint: summarizeImageEndpoint(params.url),
      modelId: params.modelId,
      hasInputImages: params.hasInputImages,
      inputImageCount: params.inputImageCount,
      includeResponseFormat: params.includeResponseFormat,
      timeoutMs: params.init.timeoutMs,
    };

    try {
      const response = await this.fetchImpl(params.url, params.init);
      const elapsedMs = Date.now() - startedAt;
      logger.info(
        {
          ...baseDetails,
          status: response.status,
          ok: response.ok,
          elapsedMs,
        },
        "image_generation_cloud_response",
      );
      return { response, elapsedMs };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      logger.warn(
        {
          ...baseDetails,
          elapsedMs,
          ...buildImageFetchErrorDetails(error),
        },
        "image_generation_response_lost",
      );
      throw error;
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
      apiKey: (typeof cloud.apiKey === "string" && cloud.apiKey.trim()) || null,
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
      modelId: params.modelId,
      hasInputImages: false,
      inputImageCount: 0,
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
      modelId: params.modelId,
      hasInputImages: true,
      inputImageCount: params.inputImages.length,
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
