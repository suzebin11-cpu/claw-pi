import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createConfigStore(
  options: { imageModelId?: string } = {},
): NexuConfigStore {
  return {
    async getConfig() {
      return {
        runtime: {
          defaultImageGenerationModelId:
            options.imageModelId ?? "clawpi-image/gpt-image-1-mini",
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
    vi.restoreAllMocks();
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

  it("uses streaming progress events for GPT Image 2 generations", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    const requests: Array<{
      body: Record<string, unknown>;
      accept: string | null;
    }> = [];

    const service = new ImageGenerationService(
      createConfigStore({ imageModelId: "clawpi-image/gpt-image-2" }),
      createEnv(tempDir),
      {
        fetchImpl: async (_url, options) => {
          const headers = new Headers(options?.headers);
          requests.push({
            body: JSON.parse(String(options?.body ?? "{}")) as Record<
              string,
              unknown
            >,
            accept: headers.get("accept"),
          });
          return new Response(
            [
              "event: image_generation.partial_image\n",
              `data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"${ONE_PIXEL_PNG}"}\n\n`,
              "event: image_generation.completed\n",
              `data: {"type":"image_generation.completed","b64_json":"${ONE_PIXEL_PNG}"}\n\n`,
              "data: [DONE]\n\n",
            ].join(""),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    );

    const result = await service.generateImage({
      prompt: "a small green robot",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      accept: "text/event-stream",
      body: {
        model: "gpt-image-2",
        stream: true,
        partial_images: 1,
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(result.modelId).toBe("clawpi-image/gpt-image-2");
    expect(result.filePath).toMatch(/generated-images[\\/].+\.png$/u);
  });

  it("falls back to the sync image endpoint when streaming is rejected before generation", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    const requests: Array<Record<string, unknown>> = [];

    const service = new ImageGenerationService(
      createConfigStore({ imageModelId: "clawpi-image/gpt-image-2" }),
      createEnv(tempDir),
      {
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(String(options?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          requests.push(body);
          if (requests.length === 1) {
            return new Response(
              JSON.stringify({
                error: { message: "Unsupported parameter: stream" },
              }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
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

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ stream: true, partial_images: 1 });
    expect(requests[1]).not.toHaveProperty("stream");
    expect(requests[1]).not.toHaveProperty("partial_images");
    expect(result.filePath).toMatch(/generated-images[\\/].+\.png$/u);
  });

  it("normalizes image generation balance and network failures", () => {
    expect(
      normalizeImageGenerationErrorMessage("token quota is not enough"),
    ).toBe("余额不足，请及时充值");
    expect(normalizeImageGenerationErrorMessage("fetch failed")).toBe(
      "图片生成请求可能已提交，但本地未收到图片结果；为避免重复扣费，已停止自动重试。",
    );
    expect(
      normalizeImageGenerationErrorMessage(
        "Request to https://yunwu.example timed out after 180000ms",
      ),
    ).toBe(
      "图片生成请求可能已提交，但本地未收到图片结果；为避免重复扣费，已停止自动重试。",
    );
  });

  it("does not retry non-idempotent image endpoint network failures", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    let requestCount = 0;

    const service = new ImageGenerationService(
      createConfigStore(),
      createEnv(tempDir),
      {
        fetchImpl: async () => {
          requestCount += 1;
          throw new Error("fetch failed");
        },
      },
    );

    await expect(
      service.generateImage({
        prompt: "a small green robot",
      }),
    ).rejects.toThrow("本地未收到图片结果");
    expect(requestCount).toBe(1);
  });

  it("logs image endpoint diagnostics when the cloud response is lost", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "clawpi-image-test-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let requestCount = 0;
    const cause = Object.assign(new Error("remote socket closed"), {
      code: "UND_ERR_SOCKET",
      syscall: "read",
    });
    const failure = new Error("fetch failed") as Error & { cause?: unknown };
    failure.cause = cause;

    const service = new ImageGenerationService(
      createConfigStore(),
      createEnv(tempDir),
      {
        fetchImpl: async () => {
          requestCount += 1;
          throw failure;
        },
      },
    );

    await expect(
      service.generateImage({
        prompt: "a small green robot",
      }),
    ).rejects.toThrow("本地未收到图片结果");

    const logs = warnSpy.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.message === "image_generation_response_lost");

    expect(requestCount).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      label: "generations",
      endpoint: "https://yunwu.example/v1/images/generations",
      modelId: "gpt-image-1-mini",
      hasInputImages: false,
      inputImageCount: 0,
      includeResponseFormat: false,
      timeoutMs: 180_000,
      errorName: "Error",
      errorMessage: "fetch failed",
      causeName: "Error",
      causeMessage: "remote socket closed",
      causeCode: "UND_ERR_SOCKET",
      causeSyscall: "read",
    });
    expect(typeof logs[0]?.elapsedMs).toBe("number");
  });
});
