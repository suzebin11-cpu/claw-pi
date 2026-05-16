import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "#controller/app/env";
import { ImageGenerationService } from "#controller/services/image-generation-service";
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
      response_format: "b64_json",
    });
    expect(result.modelId).toBe("clawpi-image/gpt-image-1-mini");
    expect(result.url).toContain(
      "http://127.0.0.1:50800/api/internal/desktop/generated-images/",
    );
    expect(result.filePath).toMatch(/generated-images[\\/].+\.png$/u);
    await expect(service.readGeneratedImage(result.fileName)).resolves.toEqual(
      expect.objectContaining({ mimeType: "image/png" }),
    );
  });

  it("retries without response_format when the upstream image endpoint rejects it", async () => {
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
          if (requests.length === 1) {
            return new Response(
              JSON.stringify({
                error: { message: "Unknown parameter: response_format" },
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
    expect(requests[0]?.body).toMatchObject({
      response_format: "b64_json",
    });
    expect(requests[1]?.body).not.toHaveProperty("response_format");
    expect(result.filePath).toMatch(/generated-images[\\/].+\.png$/u);
  });
});
