import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "#controller/app/env";
import {
  ImageGenerationService,
  normalizeImageGenerationErrorMessage,
} from "#controller/services/image-generation-service";
import type { NexuConfigStore } from "#controller/store/nexu-config-store";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createEnv(homeDir: string): ControllerEnv {
  return {
    nexuHomeDir: homeDir,
    port: 50800,
  } as unknown as ControllerEnv;
}

function createConfigStore(): NexuConfigStore {
  return {
    async getConfig() {
      return {
        runtime: {
          defaultImageGenerationModelId: "clawpi-image/gpt-image-1-mini",
        },
        desktop: {
          cloud: {
            connected: true,
            linkUrl: "https://yunwu.example",
            apiKey: "sk-test",
          },
        },
      };
    },
    async getDesktopCloudStatus() {
      return {
        linkUrl: "https://yunwu.example",
      };
    },
  } as unknown as NexuConfigStore;
}

describe("ImageGenerationService", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("calls the OpenAI-compatible image endpoint using the selected image model", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    const service = new ImageGenerationService(
      createConfigStore(),
      createEnv(tempDir),
      {
        fetchImpl: async (url, options) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(options?.body ?? "{}")) as Record<
              string,
              unknown
            >,
          });
          return new Response(
            JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );

    const result = await service.generateImage({
      prompt: "a small green robot",
      aspectRatio: "1:1",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://yunwu.example/v1/images/generations",
    );
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-image-1-mini",
      prompt: "a small green robot",
      size: "1024x1024",
    });
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(result.modelId).toBe("clawpi-image/gpt-image-1-mini");
    expect(result.url).toContain(
      "http://127.0.0.1:50800/api/internal/desktop/generated-images/",
    );
    expect(result.filePath).toMatch(/generated-images[\\/].+\.png$/u);
    await expect(service.readGeneratedImage(result.fileName)).resolves.toEqual(
      expect.objectContaining({ mimeType: "image/png" }),
    );
  });

  it("omits response_format for OpenAI-compatible image endpoint compatibility", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    const requests: Array<{ body: Record<string, unknown> }> = [];

    const service = new ImageGenerationService(
      createConfigStore(),
      createEnv(tempDir),
      {
        fetchImpl: async (_url, options) => {
          requests.push({
            body: JSON.parse(String(options?.body ?? "{}")) as Record<
              string,
              unknown
            >,
          });
          return new Response(
            JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );

    const result = await service.generateImage({
      prompt: "a small green robot",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(result.filePath).toMatch(/generated-images[\\/].+\.png$/u);
  });

  it("normalizes image generation balance and network failures", () => {
    expect(
      normalizeImageGenerationErrorMessage("token quota is not enough"),
    ).toBe("余额不足，请及时充值");
    expect(normalizeImageGenerationErrorMessage("fetch failed")).toBe(
      "图片生成服务连接失败，请稍后重试",
    );
    expect(
      normalizeImageGenerationErrorMessage(
        "Request to https://yunwu.example timed out after 180000ms",
      ),
    ).toBe("图片生成超时，请稍后重试");
  });

  it("falls back to stable model when primary model fails with 503", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

    const configStore = {
      async getConfig() {
        return {
          runtime: {
            defaultImageGenerationModelId: "clawpi-image/gpt-image-2",
          },
          desktop: {
            cloud: {
              connected: true,
              linkUrl: "https://yunwu.example",
              apiKey: "sk-test",
            },
          },
        };
      },
      async getDesktopCloudStatus() {
        return {
          linkUrl: "https://yunwu.example",
        };
      },
    } as unknown as NexuConfigStore;

    const service = new ImageGenerationService(
      configStore,
      createEnv(tempDir),
      {
        fetchImpl: async (url, options) => {
          const body = JSON.parse(String(options?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          requests.push({ url: String(url), body });

          // gpt-image-2 的所有调用都返回 503（包括重试）
          if (body.model === "gpt-image-2") {
            return new Response(
              JSON.stringify({
                error: { message: "Service temporarily unavailable" },
              }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            );
          }

          // gpt-image-1.5 成功
          return new Response(
            JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );

    const result = await service.generateImage({
      prompt: "a small green robot",
    });

    // 验证调用顺序：gpt-image-2 失败（含重试），然后兜底到 gpt-image-1.5 成功
    expect(requests.length).toBeGreaterThan(1);
    const gptImage2Calls = requests.filter(
      (r) => r.body.model === "gpt-image-2",
    );
    const gptImage15Calls = requests.filter(
      (r) => r.body.model === "gpt-image-1.5",
    );

    expect(gptImage2Calls.length).toBeGreaterThan(0);
    expect(gptImage15Calls.length).toBe(1);
    expect(requests[requests.length - 1]?.body.model).toBe("gpt-image-1.5");

    // 验证兜底标记
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackFrom).toBe("clawpi-image/gpt-image-2");
    expect(result.fallbackTo).toBe("clawpi-image/gpt-image-1.5");
    expect(result.modelId).toBe("clawpi-image/gpt-image-1.5");
  });

  it("does not fallback for balance errors", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));

    const configStore = {
      async getConfig() {
        return {
          runtime: {
            defaultImageGenerationModelId: "clawpi-image/gpt-image-2",
          },
          desktop: {
            cloud: {
              connected: true,
              linkUrl: "https://yunwu.example",
              apiKey: "sk-test",
            },
          },
        };
      },
      async getDesktopCloudStatus() {
        return {
          linkUrl: "https://yunwu.example",
        };
      },
    } as unknown as NexuConfigStore;

    const service = new ImageGenerationService(
      configStore,
      createEnv(tempDir),
      {
        fetchImpl: async () => {
          return new Response(
            JSON.stringify({ error: { message: "余额不足，请及时充值" } }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );

    await expect(
      service.generateImage({ prompt: "a small green robot" }),
    ).rejects.toThrow("余额不足，请及时充值");
  });

  it("does not fallback for safety rejection", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));

    const configStore = {
      async getConfig() {
        return {
          runtime: {
            defaultImageGenerationModelId: "clawpi-image/gpt-image-2",
          },
          desktop: {
            cloud: {
              connected: true,
              linkUrl: "https://yunwu.example",
              apiKey: "sk-test",
            },
          },
        };
      },
      async getDesktopCloudStatus() {
        return {
          linkUrl: "https://yunwu.example",
        };
      },
    } as unknown as NexuConfigStore;

    const service = new ImageGenerationService(
      configStore,
      createEnv(tempDir),
      {
        fetchImpl: async () => {
          return new Response(
            JSON.stringify({
              error: { message: "Your request was rejected by safety system" },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );

    await expect(
      service.generateImage({ prompt: "a small green robot" }),
    ).rejects.toThrow("safety system");
  });
});
