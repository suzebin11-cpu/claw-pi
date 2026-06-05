import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import {
  ImageGenerationService,
  normalizeImageGenerationErrorMessage,
} from "../src/services/image-generation-service.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";

const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

type TestImageFetch = (
  input: string | URL,
  options?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

function createConfigStore(): NexuConfigStore {
  return {
    getConfig: async () => ({
      desktop: {
        cloud: {
          connected: true,
          linkUrl: "https://yunwu.ai",
          apiKey: "test-key",
        },
      },
      runtime: {
        defaultImageGenerationModelId: "clawpi-image/gpt-image-2",
      },
    }),
    getDesktopCloudStatus: async () => ({
      linkUrl: "https://yunwu.ai",
    }),
  } as unknown as NexuConfigStore;
}

function createEnv(nexuHomeDir: string): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 50800,
    host: "127.0.0.1",
    webUrl: "http://127.0.0.1:50810",
    nexuHomeDir,
  } as ControllerEnv;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("ImageGenerationService", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs = [];
  });

  async function makeService(fetchImpl: TestImageFetch) {
    const home = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    tempDirs.push(home);
    return {
      home,
      service: new ImageGenerationService(
        createConfigStore(),
        createEnv(home),
        {
          fetchImpl,
        },
      ),
    };
  }

  it("retries gpt-image-2 stream 406 openai_error once without streaming", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (
      url: string | URL,
      init?: RequestInit & { timeoutMs?: number },
    ): Promise<Response> => {
      calls.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (calls.length === 1) {
        return jsonResponse(
          { error: { message: "openai_error (request id: test)" } },
          { status: 406 },
        );
      }
      return jsonResponse({
        data: [{ b64_json: PNG_BASE64 }],
      });
    };
    const { service } = await makeService(fetchImpl);

    const result = await service.generateImage({
      prompt: "生成一张测试图片",
    });

    expect(result.filePath).toContain("generated-images");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://yunwu.ai/v1/images/generations");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      model: "gpt-image-2",
      stream: true,
    });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toMatchObject({
      model: "gpt-image-2",
    });
    expect(JSON.parse(calls[1]?.body ?? "{}")).not.toHaveProperty("stream");
  });

  it("uses the edits endpoint when inputImages are provided", async () => {
    const urls: string[] = [];
    const fetchImpl = async (
      url: string | URL,
      init?: RequestInit & { timeoutMs?: number },
    ): Promise<Response> => {
      urls.push(String(url));
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("stream")).toBeNull();
      expect(form.get("partial_images")).toBeNull();
      expect(
        Object.entries((init?.headers ?? {}) as Record<string, string>).some(
          ([key, value]) =>
            key.toLowerCase() === "accept" &&
            value.toLowerCase().includes("text/event-stream"),
        ),
      ).toBe(false);
      return jsonResponse({
        data: [{ b64_json: PNG_BASE64 }],
      });
    };
    const { service } = await makeService(fetchImpl);

    const result = await service.generateImage({
      prompt: "基于参考图生成",
      inputImages: [`data:image/png;base64,${PNG_BASE64}`],
    });

    expect(result.filePath).toContain("generated-images");
    expect(urls).toEqual(["https://yunwu.ai/v1/images/edits"]);
  });

  it("retries transient upstream saturation before failing the image task", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (
      url: string | URL,
      init?: RequestInit & { timeoutMs?: number },
    ): Promise<Response> => {
      calls.push({
        url: String(url),
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (calls.length === 1) {
        return jsonResponse(
          { error: { message: "当前分组上游负载已饱和，请稍后再试" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      return jsonResponse({
        data: [{ b64_json: PNG_BASE64 }],
      });
    };
    const { service } = await makeService(fetchImpl);

    const result = await service.generateImage({
      prompt: "生成一张测试图片",
    });

    expect(result.filePath).toContain("generated-images");
    expect(calls).toHaveLength(2);
  });

  it("normalizes lost image responses to an actionable user message", () => {
    expect(normalizeImageGenerationErrorMessage("fetch failed")).toBe(
      "图片生成已提交但结果返回失败，请查看诊断。",
    );
    expect(normalizeImageGenerationErrorMessage("request timed out")).toBe(
      "图片生成已提交但结果返回失败，请查看诊断。",
    );
    expect(
      normalizeImageGenerationErrorMessage("HTTP 429: rate limit"),
    ).toBe(
      "生图通道繁忙，已自动重试但仍未返回图片，请再试一次或切换生图模型。",
    );
  });
});
