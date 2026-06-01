import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ControllerContainer } from "../app/container.js";
import { logger } from "../lib/logger.js";
import type { ControllerBindings } from "../types.js";

const agentChatAttachmentSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  kind: z.string().optional(),
  size: z.number().optional(),
  dataUrl: z.string().optional(),
});

const agentChatStreamBodySchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  modelId: z.string().optional().nullable(),
  agentId: z.string().optional(),
  requestRoute: z
    .enum(["chat", "image_generation", "read_only_agent", "write_agent"])
    .optional()
    .nullable(),
  permissionMode: z.enum(["basic", "confirm", "full"]).optional(),
  executionMode: z.enum(["read_only", "write"]).optional(),
  attachments: z.array(agentChatAttachmentSchema).optional(),
});

const agentChatExtractAttachmentsBodySchema = z.object({
  attachments: z.array(agentChatAttachmentSchema).optional(),
});

const extractedAttachmentSchema = z.object({
  name: z.string(),
  type: z.string(),
  kind: z.string(),
  size: z.number().optional(),
  extractedText: z.string().optional(),
  extractStatus: z.enum(["ok", "truncated", "failed", "unsupported"]),
  extractError: z.string().optional(),
});

function normalizeAgentChatError(message: string): string {
  return /(?:token quota is not enough|need quota|insufficient (?:balance|quota|credits?)|quota.+not enough|余额不足|额度不足|余额不够|充值)/iu.test(
    message,
  )
    ? "余额不足，请及时充值"
    : message;
}

function resolveDefaultAgentId(
  config: Awaited<ReturnType<ControllerContainer["configStore"]["getConfig"]>>,
): string {
  return (
    config.bots.find((bot) => bot.status === "active")?.id ??
    config.bots[0]?.id ??
    "main"
  );
}

export function registerAgentChatRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/agent-chat/extract-attachments",
      tags: ["AgentChat"],
      request: {
        body: {
          content: {
            "application/json": {
              schema: agentChatExtractAttachmentsBodySchema,
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                attachments: z.array(extractedAttachmentSchema),
              }),
            },
          },
          description:
            "Deterministically extracted workbench attachment text without invoking OpenClaw",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const attachments = await container.agentChatService.extractAttachments({
        attachments: body.attachments,
      });
      return c.json({ attachments }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/agent-chat/stream",
      tags: ["AgentChat"],
      request: {
        body: {
          content: {
            "application/json": { schema: agentChatStreamBodySchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "text/event-stream": { schema: z.string() },
          },
          description: "OpenAI-compatible stream backed by OpenClaw chat.send",
        },
        502: {
          content: {
            "text/plain": { schema: z.string() },
          },
          description: "OpenClaw agent bridge unavailable",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const config = await container.configStore.getConfig();
      const agentId = body.agentId?.trim() || resolveDefaultAgentId(config);

      try {
        return await container.agentChatService.createOpenAiCompatibleStream({
          agentId,
          sessionId: body.sessionId,
          message: body.message,
          modelId: body.modelId,
          requestRoute: body.requestRoute,
          permissionMode: body.permissionMode,
          executionMode: body.executionMode,
          attachments: body.attachments,
          signal: c.req.raw.signal,
        });
      } catch (error) {
        const message = normalizeAgentChatError(
          error instanceof Error ? error.message : "OpenClaw agent chat failed",
        );
        logger.warn(
          {
            route: "agentChat.stream",
            agentId,
            sessionId: body.sessionId,
            error: message,
          },
          "agent_chat_stream_unavailable",
        );
        return c.text(message, 502);
      }
    },
  );
}
