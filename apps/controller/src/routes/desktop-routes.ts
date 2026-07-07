import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    skipped: z.boolean().optional(),
  }),
  status: z.enum(["active", "starting", "degraded", "unhealthy"]),
  desktopReady: z.boolean(),
  webReady: z.boolean(),
  openclawReady: z.boolean(),
  agentReady: z.boolean(),
  channelsReady: z.boolean(),
  blockers: z.array(
    z.object({
      scope: z.enum(["desktop", "web", "openclaw", "agent", "channels"]),
      code: z.string(),
      message: z.string(),
    }),
  ),
  gatewayConnected: z.boolean(),
  runtimeRepair: z.object({
    inProgress: z.boolean(),
    lastReason: z.string().nullable(),
    lastLevel: z.enum(["soft", "deep"]).nullable(),
    lastRepairAt: z.number().nullable(),
    lastError: z.string().nullable(),
  }),
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

const localActionRequestSchema = z.object({
  action: z.enum([
    "openUrl",
    "openPath",
    "createFolder",
    "createTextFile",
    "createSpreadsheet",
  ]),
  url: z.string().optional(),
  target: z.enum(["desktop", "documents", "downloads", "home"]).optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  rows: z.array(z.array(z.string())).optional(),
});

const localActionResponseSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  message: z.string(),
  path: z.string().optional(),
  url: z.string().optional(),
});

type LocalActionRequest = z.infer<typeof localActionRequestSchema>;

function getDesktopPath(): string {
  const home = homedir();
  const oneDriveDesktop = path.join(home, "OneDrive", "Desktop");
  if (existsSync(oneDriveDesktop)) {
    return oneDriveDesktop;
  }
  return path.join(home, "Desktop");
}

function resolveLocalActionBase(target: LocalActionRequest["target"]): string {
  const home = homedir();
  switch (target) {
    case "documents":
      return path.join(home, "Documents");
    case "downloads":
      return path.join(home, "Downloads");
    case "home":
      return home;
    default:
      return getDesktopPath();
  }
}

function sanitizeFileName(name: string | undefined, fallback: string): string {
  const raw = name?.trim() || fallback;
  const withoutReservedChars = raw.replace(/[<>:"/\\|?*]/gu, " ");
  const cleaned = Array.from(withoutReservedChars, (char) =>
    char.charCodeAt(0) < 32 ? " " : char,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function ensureExtension(fileName: string, extension: string): string {
  return path.extname(fileName) ? fileName : `${fileName}${extension}`;
}

function resolveSafePath(input: {
  target?: LocalActionRequest["target"];
  pathValue?: string;
  name?: string;
  fallbackName: string;
  extension?: string;
}): string {
  const home = path.resolve(homedir());
  const rawPath = input.pathValue?.trim();
  const base = rawPath
    ? path.resolve(rawPath)
    : resolveLocalActionBase(input.target);
  const fileName = sanitizeFileName(input.name, input.fallbackName);
  const finalName = input.extension
    ? ensureExtension(fileName, input.extension)
    : fileName;
  const resolved = path.resolve(base, finalName);
  if (!(resolved === home || resolved.startsWith(home + path.sep))) {
    throw new Error("只能在当前用户目录内执行本机操作");
  }
  return resolved;
}

async function openDesktopTarget(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    execFile(cmd, [target], (err) => (err ? reject(err) : resolve()));
  });
}

async function openUrl(urlValue: string | undefined): Promise<string> {
  if (!urlValue) {
    throw new Error("缺少要打开的网址");
  }
  const url = new URL(urlValue);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许打开 http/https 网页");
  }
  await new Promise<void>((resolve, reject) => {
    if (process.platform === "win32") {
      execFile(
        "rundll32.exe",
        ["url.dll,FileProtocolHandler", url.toString()],
        (err) => (err ? reject(err) : resolve()),
      );
      return;
    }
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [url.toString()], (err) => (err ? reject(err) : resolve()));
  });
  return url.toString();
}

function toUniquePath(filePath: string): string {
  if (!existsSync(filePath)) {
    return filePath;
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("无法生成不重名的文件路径");
}

function escapeSpreadsheetXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function buildSpreadsheetXml(rows: string[][] | undefined, content: string) {
  const parsedRows =
    rows && rows.length > 0
      ? rows
      : content
          .split(/\r?\n/u)
          .map((line) =>
            line
              .split(/\t|,|，/u)
              .map((cell) => cell.trim())
              .filter(Boolean),
          )
          .filter((row) => row.length > 0);
  const tableRows =
    parsedRows.length > 0
      ? parsedRows
      : [
          ["项目", "内容"],
          ["示例", "由 Claw-Pi 创建"],
        ];
  const rowsXml = tableRows
    .map(
      (row) =>
        `<Row>${row
          .map(
            (cell) =>
              `<Cell><Data ss:Type="String">${escapeSpreadsheetXml(
                cell,
              )}</Data></Cell>`,
          )
          .join("")}</Row>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Sheet1">
  <Table>${rowsXml}</Table>
 </Worksheet>
</Workbook>`;
}

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
      method: "post",
      path: "/api/internal/desktop/local-actions",
      tags: ["Desktop"],
      request: {
        body: {
          content: {
            "application/json": { schema: localActionRequestSchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: localActionResponseSchema },
          },
          description: "Local desktop action result",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      try {
        if (body.action === "openUrl") {
          const url = await openUrl(body.url);
          return c.json(
            { ok: true, action: body.action, message: "已打开网页", url },
            200,
          );
        }

        if (body.action === "openPath") {
          const target = path.resolve(
            body.path?.trim() || resolveLocalActionBase(body.target),
          );
          const home = path.resolve(homedir());
          if (!(target === home || target.startsWith(home + path.sep))) {
            throw new Error("只能打开当前用户目录内的位置");
          }
          await openDesktopTarget(target);
          return c.json(
            {
              ok: true,
              action: body.action,
              message: "已打开位置",
              path: target,
            },
            200,
          );
        }

        if (body.action === "createFolder") {
          const folderPath = resolveSafePath({
            target: body.target,
            pathValue: body.path,
            name: body.name,
            fallbackName: "Claw-Pi 文件夹",
          });
          await mkdir(folderPath, { recursive: true });
          return c.json(
            {
              ok: true,
              action: body.action,
              message: "已创建文件夹",
              path: folderPath,
            },
            200,
          );
        }

        if (body.action === "createTextFile") {
          const filePath = toUniquePath(
            resolveSafePath({
              target: body.target,
              pathValue: body.path,
              name: body.name,
              fallbackName: "Claw-Pi 文档",
              extension: ".txt",
            }),
          );
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, body.content ?? "", "utf8");
          return c.json(
            {
              ok: true,
              action: body.action,
              message: "已创建文本文件",
              path: filePath,
            },
            200,
          );
        }

        const spreadsheetPath = toUniquePath(
          resolveSafePath({
            target: body.target,
            pathValue: body.path,
            name: body.name,
            fallbackName: "Claw-Pi 表格",
            extension: ".xls",
          }),
        );
        await mkdir(path.dirname(spreadsheetPath), { recursive: true });
        await writeFile(
          spreadsheetPath,
          buildSpreadsheetXml(body.rows, body.content ?? ""),
          "utf8",
        );
        return c.json(
          {
            ok: true,
            action: body.action,
            message: "已创建 Excel 表格",
            path: spreadsheetPath,
          },
          200,
        );
      } catch (error) {
        return c.json(
          {
            ok: false,
            action: body.action,
            message:
              error instanceof Error ? error.message : "本机操作执行失败",
          },
          200,
        );
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
      const gatewayConnected = container.gatewayService.isConnected();
      const runtimeRepair = container.openclawRuntimeRepair?.getStatus?.() ?? {
        inProgress: false,
        lastReason: null,
        lastLevel: null,
        lastRepairAt: null,
        lastError: null,
      };
      const openclawReady =
        gatewayConnected && (runtime.ok || runtime.skipped === true);
      const agentReady = openclawReady && modelReady;
      const blockers: Array<{
        scope: "desktop" | "web" | "openclaw" | "agent" | "channels";
        code: string;
        message: string;
      }> = [];
      if (runtime.skipped === true && !gatewayConnected) {
        blockers.push({
          scope: "openclaw",
          code: "gateway_probe_disabled_no_ws",
          message:
            "OpenClaw health probe is disabled and the gateway WebSocket is not connected.",
        });
      } else if (!runtime.ok && runtime.status !== null) {
        blockers.push({
          scope: "openclaw",
          code: `openclaw_health_http_${runtime.status}`,
          message: `OpenClaw health endpoint returned HTTP ${runtime.status}.`,
        });
      } else if (!runtime.ok && !runtime.skipped) {
        blockers.push({
          scope: "openclaw",
          code: "openclaw_health_unreachable",
          message: "OpenClaw health endpoint is unreachable.",
        });
      }
      if (!gatewayConnected) {
        blockers.push({
          scope: "openclaw",
          code: "openclaw_ws_disconnected",
          message: "Controller is not connected to the OpenClaw gateway.",
        });
      }
      if (!modelReady) {
        blockers.push({
          scope: "agent",
          code: "model_not_ready",
          message:
            "The effective OpenClaw runtime model is missing or does not match the configured default model.",
        });
      }

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
          desktopReady: true,
          webReady: true,
          openclawReady,
          agentReady,
          channelsReady: openclawReady,
          blockers,
          workspacePath: preferredBot
            ? path.join(
                container.env.openclawStateDir,
                "agents",
                preferredBot.id,
              )
            : path.join(container.env.openclawStateDir, "agents"),
          runtime,
          status: container.runtimeState.status,
          gatewayConnected,
          runtimeRepair,
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
