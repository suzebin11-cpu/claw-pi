import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ControllerContainer } from "../app/container.js";
import type { ControllerBindings } from "../types.js";

const imageGenerationBodySchema = z.object({
  prompt: z.string().min(1).max(4000),
  modelId: z.string().optional(),
  size: z.string().optional(),
  aspectRatio: z.string().optional(),
  inputImages: z.array(z.string().min(1)).max(4).optional(),
});

const imageGenerationResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  modelId: z.string(),
  prompt: z.string(),
  fileName: z.string(),
  filePath: z.string(),
  mimeType: z.string(),
  url: z.string(),
  markdown: z.string(),
  durationMs: z.number(),
});

const imageGenerationErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

const generatedImageParamSchema = z.object({
  fileName: z.string(),
});

export function registerImageGenerationRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/images/generations",
      tags: ["Desktop", "Images", "Internal"],
      request: {
        body: {
          content: {
            "application/json": { schema: imageGenerationBodySchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: imageGenerationResponseSchema },
          },
          description: "Generated image",
        },
        400: {
          content: {
            "application/json": { schema: imageGenerationErrorSchema },
          },
          description: "Image generation failed",
        },
      },
    }),
    async (c) => {
      try {
        const result = await container.imageGenerationService.generateImage(
          c.req.valid("json"),
        );
        return c.json({ ok: true as const, ...result }, 200);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "图片生成失败，请稍后重试";
        return c.json({ ok: false as const, error: message }, 400);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/generated-images/{fileName}",
      tags: ["Desktop", "Images", "Internal"],
      request: { params: generatedImageParamSchema },
      responses: {
        200: {
          content: { "image/png": { schema: z.string() } },
          description: "Generated image file",
        },
        404: {
          content: {
            "application/json": {
              schema: z.object({ message: z.string() }),
            },
          },
          description: "Generated image not found",
        },
      },
    }),
    async (c) => {
      const { fileName } = c.req.valid("param");
      const image =
        await container.imageGenerationService.readGeneratedImage(fileName);
      if (!image) {
        return c.json({ message: "Generated image not found" }, 404);
      }
      return new Response(image.bytes, {
        status: 200,
        headers: {
          "Content-Type": image.mimeType,
          "Cache-Control": "private, max-age=86400",
        },
      });
    },
  );
}
