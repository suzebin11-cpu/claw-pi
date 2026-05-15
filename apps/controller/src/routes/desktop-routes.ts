import { execFile } from "node:child_process";
import path from "node:path";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ControllerContainer } from "../app/container.js";
import type { ControllerBindings } from "../types.js";

const desktopReadyResponseSchema = z.object({
  ready: z.boolean(),
  workspacePath: z.string(),
  runtime: z.object({
    ok: z.boolean(),
    status: z.number().nullable(),
  }),
  status: z.enum(["active", "starting", "degraded", "unhealthy"]),
  gatewayConnected: z.boolean(),
  model: z.object({
    ready: z.boolean(),
    defaultModelId: z.string().nullable(),
    effectiveModelId: z.string().nullable(),
  }),
  openclawDashboardUrl: z.string().optional(),
  openclawChatUrl: z.string().optional(),
  bootTimestamp: z.number(),
});

const fallbackEventSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  channel: z.string(),
  status: z.string(),
  reasonCode: z.string().nullable(),
  accountId: z.string().nullable(),
  to: z.string().nullable(),
  threadId: z.string().nullable(),
  sessionKey: z.string().nullable(),
  actionId: z.string().nullable(),
  fallbackOutcome: z.enum(["sent", "skipped", "failed"]),
  fallbackReason: z.string(),
  error: z.string().nullable(),
  sendResult: z
    .object({
      runId: z.string().optional(),
      messageId: z.string().optional(),
      channel: z.string().optional(),
      chatId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .nullable(),
});

const fallbackEventsResponseSchema = z.object({
  events: z.array(fallbackEventSchema),
});

const fallbackEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const desktopPreferencesResponseSchema = z.object({
  locale: z.enum(["en", "zh-CN"]).nullable(),
});

const desktopPreferencesUpdateSchema = z.object({
  locale: z.enum(["en", "zh-CN"]),
});

export function registerDesktopRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  const shellOpenRequestSchema = z.object({
    path: z.string().min(1),
  });

  const shellOpenResponseSchema = z.object({
    ok: z.boolean(),
    error: z.string().optional(),
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/shell-open",
      tags: ["Desktop"],
      request: {
        body: {
          content: {
            "application/json": { schema: shellOpenRequestSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: shellOpenResponseSchema },
          },
          description: "Shell open result",
        },
        403: {
          content: {
            "application/json": { schema: shellOpenResponseSchema },
          },
          description: "Path not allowed",
        },
      },
    }),
    async (c) => {
      const { path: targetPath } = c.req.valid("json");
      const resolved = path.resolve(targetPath);
      const allowedRoot = path.resolve(container.env.openclawStateDir);
      const allowedWorkspaceRoot = path.resolve(
        path.join(container.env.openclawStateDir, "agents"),
      );

      if (
        !(
          resolved.startsWith(allowedRoot + path.sep) ||
          resolved === allowedRoot ||
          resolved.startsWith(allowedWorkspaceRoot + path.sep) ||
          resolved === allowedWorkspaceRoot
        )
      ) {
        return c.json(
          { ok: false, error: "Path outside allowed directory" },
          403,
        );
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const cmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "explorer"
                : "xdg-open";
          execFile(cmd, [resolved], (err) => (err ? reject(err) : resolve()));
        });
        return c.json({ ok: true }, 200);
      } catch {
        return c.json({ ok: false, error: "Failed to open folder" }, 200);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/ready",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: desktopReadyResponseSchema },
          },
          description: "Desktop runtime ready status",
        },
      },
    }),
    async (c) => {
      const runtime = await container.runtimeHealth.probe();
      const config = await container.configStore.getConfig();
      const effectiveModelId =
        await container.runtimeModelStateService.getEffectiveModelId();
      const configuredModelId = config.runtime.defaultModelId ?? null;
      const modelReady =
        effectiveModelId !== null &&
        (configuredModelId === null || effectiveModelId === configuredModelId);
      const bots = await container.configStore.listBots();
      const preferredBot =
        bots.find((bot) => bot.status === "active") ??
        bots.find((bot) => bot.status !== "deleted") ??
        null;

      const gatewayPort = container.env.openclawGatewayPort;
      const gatewayToken = container.env.openclawGatewayToken;
      const openclawDashboardUrl = gatewayToken
        ? `http://127.0.0.1:${gatewayPort}/#token=${encodeURIComponent(gatewayToken)}`
        : `http://127.0.0.1:${gatewayPort}/`;
      const openclawChatUrl = gatewayToken
        ? `http://127.0.0.1:${gatewayPort}/chat#token=${encodeURIComponent(gatewayToken)}`
        : `http://127.0.0.1:${gatewayPort}/chat`;

      return c.json(
        {
          ready: true,
          workspacePath: preferredBot
            ? path.join(
                container.env.openclawStateDir,
                "agents",
                preferredBot.id,
              )
            : path.join(container.env.openclawStateDir, "agents"),
          runtime,
          status: container.runtimeState.status,
          gatewayConnected: container.gatewayService.isConnected(),
          model: {
            ready: modelReady,
            defaultModelId: configuredModelId,
            effectiveModelId,
          },
          openclawDashboardUrl,
          openclawChatUrl,
          bootTimestamp: container.bootTimestamp,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/fallback-events",
      tags: ["Desktop"],
      request: {
        query: fallbackEventsQuerySchema,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: fallbackEventsResponseSchema },
          },
          description: "Recent channel fallback diagnostics",
        },
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      return c.json(
        {
          events: container.channelFallbackService.listRecentEvents(
            query.limit,
          ),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/preferences",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: desktopPreferencesResponseSchema },
          },
          description: "Desktop preferences",
        },
      },
    }),
    async (c) => {
      return c.json(
        {
          locale: await container.configStore.getStoredDesktopLocale(),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/internal/desktop/preferences",
      tags: ["Desktop"],
      request: {
        body: {
          content: {
            "application/json": { schema: desktopPreferencesUpdateSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: desktopPreferencesResponseSchema },
          },
          description: "Updated desktop preferences",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        {
          locale: await container.configStore.setDesktopLocale(body.locale),
        },
        200,
      );
    },
  );
}
