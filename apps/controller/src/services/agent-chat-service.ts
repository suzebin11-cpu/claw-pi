import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pdfjsLegacy from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import type {
  OpenClawGatewayEvent,
  OpenClawWsClient,
} from "../runtime/openclaw-ws-client.js";

export interface AgentChatAttachment {
  name?: string;
  type?: string;
  kind?: string;
  size?: number;
  dataUrl?: string;
}

export interface AgentChatStreamInput {
  agentId: string;
  sessionId: string;
  message: string;
  modelId?: string | null;
  requestRoute?: AgentChatRequestRoute | null;
  permissionMode?: AgentPermissionMode | null;
  executionMode?: AgentExecutionMode | null;
  attachments?: AgentChatAttachment[];
  signal?: AbortSignal;
}

export interface ExtractedAgentChatAttachment {
  name: string;
  type: string;
  kind: string;
  size?: number;
  extractedText?: string;
  extractStatus: AttachmentExtractStatus;
  extractError?: string;
}

type AgentPermissionMode = "basic" | "confirm" | "full";
export type AgentExecutionMode = "read_only" | "write";
export type AgentChatRequestRoute =
  | "chat"
  | "image_generation"
  | "read_only_agent"
  | "write_agent";

type OpenClawChatEventPayload = {
  sessionKey?: unknown;
  runId?: unknown;
  state?: unknown;
  message?: unknown;
  errorMessage?: unknown;
};

type OpenClawImageAttachment = {
  type: "image";
  mimeType: string;
  content: string;
};

export type AgentChatErrorCategory =
  | "model_network_error"
  | "upstream_saturated"
  | "insufficient_balance"
  | "auth_expired"
  | "model_auth_not_ready"
  | "openclaw_not_ready"
  | "image_response_lost"
  | "attachment_extract_failed"
  | "wechat_qr_pending"
  | "update_failed"
  | "unknown";

type AgentChatPreflightSyncService = {
  syncAllImmediate(): Promise<{ configPushed: boolean }>;
  getCurrentSyncPromise?(): Promise<{ configPushed: boolean }> | null;
  getSyncStatus?(): {
    hasSuccessfulSync: boolean;
    lastSuccessfulSyncAt: number | null;
    lastFailedSyncAt: number | null;
  };
};

type SavedWorkbenchFile = {
  name: string;
  path: string;
  type: string;
  kind: string;
  extractedText?: string;
  extractStatus: AttachmentExtractStatus;
  extractError?: string;
};

type AttachmentExtractStatus = "ok" | "truncated" | "unsupported" | "failed";

type PdfJsTextItem = {
  str?: string;
  transform?: number[];
};

type PdfJsPage = {
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items?: PdfJsTextItem[] }>;
};

type PdfJsDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy?: () => void | Promise<void>;
};

type PdfJsModule = {
  disableWorker?: boolean;
  getDocument(data: Buffer | { data: Uint8Array }): Promise<PdfJsDocument>;
};

const AGENT_CHAT_TIMEOUT_MS = 300_000;
const AGENT_CHAT_STREAM_KEEPALIVE_MS = 15_000;
const OPENCLAW_GATEWAY_READY_TIMEOUT_MS = 360_000;
const OPENCLAW_GATEWAY_READY_POLL_MS = 250;
const AGENT_CHAT_PROGRESS_AUTO_CONTINUE_MAX_TURNS = 4;
const AGENT_CHAT_EMPTY_FINAL_RETRY_MAX_TURNS = 1;
const AGENT_CHAT_AUTO_CONTINUE_MAX_FINAL_CHARS = 1600;
const ATTACHMENT_EXTRACT_MAX_CHARS = 12_000;
const INSUFFICIENT_BALANCE_MESSAGE = "余额不足，请及时充值";
const AUTH_EXPIRED_MESSAGE = "登录状态已过期，请重新登录";
const UPSTREAM_SATURATED_MESSAGE = "上游分组负载饱和，请稍后再试";
const MODEL_AUTH_NOT_READY_MESSAGE =
  "模型账号未就绪，请重新登录或检查云雾连接。";
const MODEL_NETWORK_ERROR_MESSAGE = "模型连接失败，请稍后重试。";
const OPENCLAW_CONFIG_SYNC_FAILED_MESSAGE =
  "OpenClaw 配置同步失败，请稍后重试。";
const OPENCLAW_NOT_READY_MESSAGE = "OpenClaw 本地服务未就绪，正在重试。";
const IMAGE_RESPONSE_LOST_MESSAGE =
  "图片生成已提交但结果返回失败，请查看诊断。";
const AGENT_CHAT_EMPTY_RESPONSE_MESSAGE =
  "任务没有返回可见结果，请重试或导出诊断包。";
const AGENT_CHAT_AUTO_CONTINUE_PROMPT =
  "继续执行当前任务。不要解释权限、软限制、工具额度，也不要只回复计划、状态或道歉；需要本机/文件/网页/生图操作时，立即调用 OpenClaw 可用工具完成。最终回复只能是完成结果、产物路径/图片链接，或明确的真实阻塞原因与所需输入。";
const AGENT_CHAT_EMPTY_ATTACHMENT_RETRY_PROMPT =
  "上一轮没有产生可见回复。当前任务包含工作台上传附件：必须优先使用下列附件正文或文件路径完成用户任务。不要只回复计划、状态或道歉；最终直接给出结果，或明确说明真实阻塞原因。";
const GENERATED_IMAGE_URL_PATTERN =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif)/iu;
const SOFT_TOOL_LIMIT_FINAL_PATTERNS = [
  /(?:工具额度|软限制|soft limit|tool quota|tool limit|permission soft)/iu,
  /(?:无法|不能|没法)(?:[^。！？.!?\n]{0,40})(?:继续|直接|自动)(?:[^。！？.!?\n]{0,40})(?:打开|执行|操作)/iu,
  /(?:请|可以)(?:[^。！？.!?\n]{0,40})(?:手动|自己)(?:[^。！？.!?\n]{0,40})(?:打开|执行|操作)/iu,
  /(?:权限|工具)(?:[^。！？.!?\n]{0,40})(?:受限|限制|不可用|不足)/iu,
];
const PROGRESS_FINAL_PATTERNS = [
  /(?:^|[。！？.!?\s])(?:我(?:先|会先|继续|会继续|现在|这边|马上|再|重新|直接|改为|换成|需要|准备|将|会)|现在|接下来|下一步|先|稍等|正在)(?:[^。！？.!?\n]{0,80})(?:找|查|搜|定位|读取|提取|处理|执行|尝试|确认|使用|调用|改用|换|继续|扩大|分析|修复|检查|验证|生成|创建|打开|运行|总结)/u,
  /(?:^|[。！？.!?\s])(?:i(?:'ll| will| am| am going to)?\s*)(?:check|search|look|find|read|extract|process|continue|try|switch|verify|use|run|execute|generate|create)\b/iu,
  /(?:先|继续|接着|随后|然后|最后)(?:[^。！？.!?\n]{0,80})(?:找|查|搜|定位|读取|提取|处理|执行|尝试|确认|使用|调用|总结|生成|创建|打开|运行)/u,
];
const COMPLETION_FINAL_PATTERNS = [
  /(?:任务|处理|操作)?(?:已|已经)(?:完成|结束|处理完|办完)/iu,
  /(?:总结|结论|结果|最终)(?:如下|是|：|:)/iu,
  /(?:这里是|以下是|下面是)(?:[^。！？.!?\n]{0,20})(?:结果|总结|结论)/iu,
  /(?:all done|task complete|completed|finished|here(?:'s| is) (?:the )?(?:result|summary))/iu,
];

const pdfjs = pdfjsLegacy as PdfJsModule;

function sanitizeSessionPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);

  if (sanitized.length > 0) {
    return sanitized;
  }

  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function buildWorkbenchSessionKey(agentId: string, sessionId: string): string {
  return `agent:${sanitizeSessionPart(agentId || "main")}:workbench:${sanitizeSessionPart(
    sessionId,
  )}`;
}

function parseDataUrl(
  dataUrl: string,
): { mimeType: string; content: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || "image/png",
    content: match[2] || "",
  };
}

function truncateExtractedText(text: string): {
  text: string;
  status: AttachmentExtractStatus;
} {
  const normalized = text
    .replace(/\r\n/gu, "\n")
    .split("\u0000")
    .join("")
    .trim();
  if (normalized.length <= ATTACHMENT_EXTRACT_MAX_CHARS) {
    return { text: normalized, status: "ok" };
  }
  return {
    text: `${normalized.slice(0, ATTACHMENT_EXTRACT_MAX_CHARS).trimEnd()}\n\n[content truncated]`,
    status: "truncated",
  };
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/\n\s+/gu, "\n");
}

function isTextLikeAttachment(input: {
  name: string;
  type: string;
  kind: string;
}): boolean {
  const extension = path.extname(input.name).toLowerCase();
  return (
    input.kind === "text" ||
    input.type.startsWith("text/") ||
    [
      ".csv",
      ".css",
      ".htm",
      ".html",
      ".js",
      ".json",
      ".log",
      ".md",
      ".py",
      ".sql",
      ".ts",
      ".txt",
      ".xml",
      ".yaml",
      ".yml",
    ].includes(extension)
  );
}

function isHtmlAttachment(input: { name: string; type: string }): boolean {
  const extension = path.extname(input.name).toLowerCase();
  return (
    input.type.includes("html") || extension === ".html" || extension === ".htm"
  );
}

function isPdfAttachment(input: { name: string; type: string }): boolean {
  return (
    input.type === "application/pdf" ||
    path.extname(input.name).toLowerCase() === ".pdf"
  );
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  pdfjs.disableWorker = true;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pages: string[] = [];
  try {
    const pageCount = Math.max(0, doc.numPages);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let pageText = "";
      for (const item of textContent.items ?? []) {
        const text = item.str ?? "";
        if (!text) {
          continue;
        }
        const y = Array.isArray(item.transform) ? item.transform[5] : undefined;
        if (lastY === undefined || y === undefined || y === lastY) {
          pageText += text;
        } else {
          pageText += `\n${text}`;
        }
        lastY = y;
      }
      if (pageText.trim()) {
        pages.push(pageText.trim());
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return pages.join("\n\n");
}

async function extractAttachmentText(input: {
  name: string;
  type: string;
  kind: string;
  content: Buffer;
}): Promise<{
  extractedText?: string;
  extractStatus: AttachmentExtractStatus;
  extractError?: string;
}> {
  try {
    if (isTextLikeAttachment(input)) {
      const raw = input.content.toString("utf8");
      const text = isHtmlAttachment(input) ? stripHtmlToText(raw) : raw;
      const extracted = truncateExtractedText(text);
      if (!extracted.text) {
        return {
          extractStatus: "failed",
          extractError: "附件没有可提取的文本内容。",
        };
      }
      return {
        extractedText: extracted.text,
        extractStatus: extracted.status,
      };
    }

    if (isPdfAttachment(input)) {
      const extracted = truncateExtractedText(
        await extractPdfText(input.content),
      );
      if (!extracted.text) {
        return {
          extractStatus: "failed",
          extractError: "PDF 没有可提取的文本内容，可能是扫描版或图片型 PDF。",
        };
      }
      return {
        extractedText: extracted.text,
        extractStatus: extracted.status,
      };
    }

    return {
      extractStatus: "unsupported",
      extractError: "暂不支持自动提取该附件类型的文本。",
    };
  } catch (error) {
    return {
      extractStatus: "failed",
      extractError: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeImageAttachments(
  attachments: readonly AgentChatAttachment[] | undefined,
): OpenClawImageAttachment[] | undefined {
  const normalized = (attachments ?? []).flatMap((attachment) => {
    if (attachment.kind !== "image" || !attachment.dataUrl) {
      return [];
    }

    const parsed = parseDataUrl(attachment.dataUrl);
    if (!parsed?.content) {
      return [];
    }

    return [
      {
        type: "image" as const,
        mimeType: attachment.type || parsed.mimeType,
        content: parsed.content,
      },
    ];
  });

  return normalized.length > 0 ? normalized : undefined;
}

function normalizePermissionMode(
  _mode: AgentPermissionMode | null | undefined,
): AgentPermissionMode {
  return "full";
}

function normalizeExecutionMode(
  _mode: AgentExecutionMode | null | undefined,
): AgentExecutionMode {
  return "write";
}

function normalizeRequestRoute(
  route: AgentChatRequestRoute | null | undefined,
): AgentChatRequestRoute {
  if (route === "image_generation") return "image_generation";
  if (route === "chat") return "chat";
  return "write_agent";
}

function isSoftToolLimitFinal(message: string): boolean {
  const normalized = cleanAssistantText(message).replace(/\s+/gu, " ").trim();
  return SOFT_TOOL_LIMIT_FINAL_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function isInsufficientBalanceError(message: string): boolean {
  return /(?:token quota is not enough|need quota|insufficient (?:balance|quota|credits?)|quota.+not enough|余额不足|额度不足|余额不够|充值)/iu.test(
    message,
  );
}

function isAuthExpiredError(message: string): boolean {
  return /(?:token|jwt|登录|登陆|auth|authorization).{0,24}(?:过期|expired)|(?:unauthorized|not authenticated|未登录|未认证)/iu.test(
    message,
  );
}

function isUpstreamSaturatedError(message: string): boolean {
  return /(?:上游.*(?:负载|分组).*(?:饱和|繁忙)|当前分组上游负载已饱和|upstream.*(?:saturat|overload|busy)|rate limit|too many requests|HTTP 429|\b429\b)/iu.test(
    message,
  );
}

function isModelAuthNotReadyError(message: string): boolean {
  return /(?:No API key found for provider ["']?link["']?|auth-profiles\.json|Configure auth for this agent)/iu.test(
    message,
  );
}

function isModelNetworkError(message: string): boolean {
  return /(?:LLM request failed:\s*)?(?:network connection error|connection error|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/iu.test(
    message,
  );
}

function isOpenClawNotReadyError(message: string): boolean {
  return /(?:OpenClaw 配置同步失败|config sync failed|sync.*auth.*profile|openclaw gateway not connected|gateway not connected|not paired|pairing required|device token mismatch|device signature invalid|request ".*" timed out|OpenClaw agent chat timed out)/iu.test(
    message,
  );
}

function isImageResponseLostError(message: string): boolean {
  return /(?:图片生成请求未返回完整图片结果|图片生成.*返回失败|image generation.*(?:timed out|timeout|response.*lost|failed)|生图.*(?:超时|返回失败|未返回))/iu.test(
    message,
  );
}

export function classifyAgentChatErrorMessage(
  message: string,
): AgentChatErrorCategory {
  if (isInsufficientBalanceError(message)) return "insufficient_balance";
  if (isAuthExpiredError(message)) return "auth_expired";
  if (isModelAuthNotReadyError(message)) return "model_auth_not_ready";
  if (isUpstreamSaturatedError(message)) return "upstream_saturated";
  if (isImageResponseLostError(message)) return "image_response_lost";
  if (isOpenClawNotReadyError(message)) return "openclaw_not_ready";
  if (isModelNetworkError(message)) return "model_network_error";
  return "unknown";
}

export function normalizeAgentChatUserMessage(message: string): string {
  if (
    message === OPENCLAW_CONFIG_SYNC_FAILED_MESSAGE ||
    /(?:OpenClaw 配置同步失败|config sync failed|sync.*auth.*profile)/iu.test(
      message,
    )
  ) {
    return OPENCLAW_CONFIG_SYNC_FAILED_MESSAGE;
  }
  switch (classifyAgentChatErrorMessage(message)) {
    case "insufficient_balance":
      return INSUFFICIENT_BALANCE_MESSAGE;
    case "auth_expired":
      return AUTH_EXPIRED_MESSAGE;
    case "model_auth_not_ready":
      return MODEL_AUTH_NOT_READY_MESSAGE;
    case "upstream_saturated":
      return UPSTREAM_SATURATED_MESSAGE;
    case "image_response_lost":
      return IMAGE_RESPONSE_LOST_MESSAGE;
    case "openclaw_not_ready":
      return OPENCLAW_NOT_READY_MESSAGE;
    case "model_network_error":
      return MODEL_NETWORK_ERROR_MESSAGE;
    default:
      return message;
  }
}

function isUserFacingAgentError(message: string): boolean {
  return (
    message === INSUFFICIENT_BALANCE_MESSAGE ||
    message === AUTH_EXPIRED_MESSAGE ||
    message === UPSTREAM_SATURATED_MESSAGE ||
    message === MODEL_AUTH_NOT_READY_MESSAGE ||
    message === MODEL_NETWORK_ERROR_MESSAGE ||
    message === OPENCLAW_CONFIG_SYNC_FAILED_MESSAGE ||
    message === OPENCLAW_NOT_READY_MESSAGE ||
    message === IMAGE_RESPONSE_LOST_MESSAGE
  );
}

function buildAutoContinuePrompt(_executionMode: AgentExecutionMode): string {
  return AGENT_CHAT_AUTO_CONTINUE_PROMPT;
}

function buildEmptyAttachmentRetryPrompt(input: {
  userMessage: string;
  files: ReadonlyArray<SavedWorkbenchFile>;
}): string {
  return [
    AGENT_CHAT_EMPTY_ATTACHMENT_RETRY_PROMPT,
    "上传附件：",
    formatSavedFileList(input.files),
    "用户原始任务：",
    input.userMessage,
  ].join("\n\n");
}

function buildPermissionDirective(_mode: AgentPermissionMode): string {
  return [
    "权限=完全访问：默认拥有本机读写、网页、命令、附件、图片生成和图生图执行能力。",
    "可用工具包含 read/write/edit/exec/web_search/image_generate 等时，除非真实失败，不要声称无法直接操作。",
    "上传文件优先使用工作台提供的本机路径和正文；图片任务必须把图片路径传给 image_generate.inputImages。",
  ].join("\n");
}

function buildWorkbenchSystemPrompt(input: {
  permissionMode: AgentPermissionMode;
  executionMode: AgentExecutionMode;
  requestRoute: AgentChatRequestRoute;
}): string {
  if (input.requestRoute === "chat") {
    return [
      "你是 OpenClaw 龙虾 agent，所有回复仍必须通过 OpenClaw runner 产生。",
      "这是龙虾工作台的全能力普通对话请求。能直接回答就直接回答；如果用户当前消息或上下文需要本机、文件、网页、命令、附件或图片能力，直接调用可用工具完成。",
      buildPermissionDirective(input.permissionMode),
    ].join("\n\n");
  }

  const modeDirective =
    input.requestRoute === "image_generation"
      ? [
          "执行模式=图片生成：用户要求生成图片、画图、做图、改图、修图、换背景或图生图时，必须调用 image_generate 生成实际图片。",
          "如果图片任务基于上传附件，必须使用工作台提供的本机图片路径作为 image_generate.inputImages；不要只传原始文件名。",
          "最终答复必须包含实际图片链接/产物路径，或明确的上游、认证、余额、网络、输入阻塞原因。",
        ].join("\n")
      : [
          "执行模式=全能力执行：用户要求查找、读取、分析、总结、创建、保存、修改、打开、运行、生成图片或处理文件时，直接调用可用工具完成。",
          "不要把权限不足、工具额度、软限制、请用户手动操作或仅说明计划作为最终答复；如果真实失败，只能返回具体错误原因与所需输入。",
        ].join("\n");

  return [
    "你是 OpenClaw 龙虾 agent，必须通过 OpenClaw runner 完成工作台任务；不要退化成普通聊天模型。",
    "这是龙虾工作台的直接对话请求，优先回答用户当前消息。",
    modeDirective,
    "如果用户要求查找/读取/处理本机文件、运行命令、打开网页/应用、生成或修改图片，必须先调用可用工具执行；不要把“我会/我先/我正在/我准备”这类计划或进度说明作为最终答复。",
    "如果用户明确要求打开网页、打开文件或打开浏览器，必须调用可用工具执行打开动作；不要只建议用户手动打开，也不要把工具额度/软限制作为最终答复。",
    "最终答复必须包含实际结果、产物路径/图片链接，或明确阻塞原因与所需输入；任务没完成时继续执行。",
    buildPermissionDirective(input.permissionMode),
  ].join("\n\n");
}

function buildAgentMessage(input: {
  message: string;
  permissionMode: AgentPermissionMode;
  executionMode: AgentExecutionMode;
  requestRoute: AgentChatRequestRoute;
}): string {
  return [
    "以下为龙虾工作台注入的运行约束，优先级高于用户当前消息：",
    buildWorkbenchSystemPrompt({
      permissionMode: input.permissionMode,
      executionMode: input.executionMode,
      requestRoute: input.requestRoute,
    }),
    "用户当前消息如下：",
    input.message,
  ].join("\n\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractMessageText).filter(Boolean).join("\n");
  }

  if (!isObject(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  const details = isObject(value.details) ? value.details : null;
  if (details) {
    const markdown = extractGeneratedImageText(details);
    if (markdown) {
      return markdown;
    }
  }

  const markdown = extractGeneratedImageText(value);
  if (markdown) {
    return markdown;
  }

  if ("content" in value) {
    const contentText = extractMessageText(value.content);
    if (details) {
      const detailsText = extractGeneratedImageText(details);
      if (detailsText && !contentText.includes(detailsText)) {
        return [contentText, detailsText].filter(Boolean).join("\n");
      }
    }
    return contentText;
  }

  return "";
}

function extractGeneratedImageText(value: Record<string, unknown>): string {
  const markdown =
    typeof value.markdown === "string" ? value.markdown.trim() : "";
  if (markdown && GENERATED_IMAGE_URL_PATTERN.test(markdown)) {
    return markdown;
  }

  const mediaUrl =
    typeof value.mediaUrl === "string"
      ? value.mediaUrl.trim()
      : Array.isArray(value.mediaUrls) && typeof value.mediaUrls[0] === "string"
        ? value.mediaUrls[0].trim()
        : typeof value.url === "string"
          ? value.url.trim()
          : "";
  if (mediaUrl && GENERATED_IMAGE_URL_PATTERN.test(mediaUrl)) {
    return `![生成图片](${mediaUrl})`;
  }

  const media = isObject(value.media) ? value.media : null;
  return media ? extractGeneratedImageText(media) : "";
}

function cleanAssistantText(text: string): string {
  return text.replace(
    /\[\[(?:reply_to_current|_current_to_reply)\]\]\s*/giu,
    "",
  );
}

function shouldAutoContinueFinal(input: {
  finalText: string;
  autoContinueTurns: number;
  maxTurns: number;
  userMessage: string;
  savedFileCount: number;
}): boolean {
  if (input.autoContinueTurns >= input.maxTurns) {
    return false;
  }

  const normalized = cleanAssistantText(input.finalText)
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !normalized ||
    normalized.length > AGENT_CHAT_AUTO_CONTINUE_MAX_FINAL_CHARS
  ) {
    return false;
  }

  if (GENERATED_IMAGE_URL_PATTERN.test(normalized)) {
    return false;
  }

  if (isSoftToolLimitFinal(normalized)) {
    return true;
  }

  if (!PROGRESS_FINAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (
    COMPLETION_FINAL_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    !/(?:继续|接着|下一步|现在|随后|我会|i(?:'ll| will| am))/iu.test(normalized)
  ) {
    return false;
  }

  return true;
}

function asChatPayload(payload: unknown): OpenClawChatEventPayload | null {
  return isObject(payload) ? (payload as OpenClawChatEventPayload) : null;
}

function extractSessionKey(payload: unknown): string | null {
  if (!isObject(payload)) {
    return null;
  }

  if (typeof payload.sessionKey === "string") {
    return payload.sessionKey;
  }

  const session = isObject(payload.session) ? payload.session : null;
  if (typeof session?.key === "string") {
    return session.key;
  }
  if (typeof session?.sessionKey === "string") {
    return session.sessionKey;
  }

  return null;
}

function getObjectString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function messageHasToolActivity(message: unknown): boolean {
  if (Array.isArray(message)) {
    return message.some(messageHasToolActivity);
  }
  if (!isObject(message)) {
    return false;
  }

  const role = getObjectString(message, "role");
  const name = getObjectString(message, "name");
  const type = getObjectString(message, "type");
  if (
    /(?:tool|toolResult|tool_result|exec|read|write|edit|image_generate|web_search|command|shell)/iu.test(
      [role, name, type].join(" "),
    )
  ) {
    return true;
  }

  if (Array.isArray(message.content)) {
    return message.content.some(messageHasToolActivity);
  }

  return false;
}

function isToolActivityEvent(event: OpenClawGatewayEvent): boolean {
  const eventName = event.event.toLowerCase();
  if (
    /(?:tool|exec|read|write|edit|image_generate|web_search|fetch|browser|command|shell)/iu.test(
      eventName,
    )
  ) {
    return true;
  }

  const payload = isObject(event.payload) ? event.payload : null;
  if (!payload) {
    return false;
  }

  if (messageHasToolActivity(payload.message)) {
    return true;
  }

  return /(?:tool|exec|read|write|edit|image_generate|web_search|fetch|browser|command|shell)/iu.test(
    [
      getObjectString(payload, "type"),
      getObjectString(payload, "name"),
      getObjectString(payload, "tool"),
      getObjectString(payload, "toolName"),
      getObjectString(payload, "command"),
    ].join(" "),
  );
}

function toSseChunk(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function toSseComment(comment: string): Uint8Array {
  return new TextEncoder().encode(`: ${comment}\n\n`);
}

function toDoneChunk(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timeout.unref?.();

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AgentChatService {
  private preflightSyncPromise: Promise<{ configPushed: boolean }> | null =
    null;

  constructor(
    private readonly wsClient: OpenClawWsClient,
    private readonly env: ControllerEnv,
    private readonly preflightSyncService?: AgentChatPreflightSyncService,
  ) {}

  async extractAttachments(input: {
    attachments: readonly AgentChatAttachment[] | undefined;
  }): Promise<ExtractedAgentChatAttachment[]> {
    const extractedAttachments: ExtractedAgentChatAttachment[] = [];
    for (const attachment of input.attachments ?? []) {
      const name = sanitizeFileName(attachment.name || "attachment");
      const parsed = parseDataUrl(attachment.dataUrl ?? "");
      const type =
        attachment.type || parsed?.mimeType || "application/octet-stream";
      const kind = attachment.kind || "file";
      if (!parsed?.content) {
        extractedAttachments.push({
          name,
          type,
          kind,
          size: attachment.size,
          extractStatus: "failed",
          extractError: "附件内容为空或无法读取。",
        });
        continue;
      }

      const content = Buffer.from(parsed.content, "base64");
      const extracted = await extractAttachmentText({
        name,
        type,
        kind,
        content,
      });
      extractedAttachments.push({
        name,
        type,
        kind,
        size: attachment.size,
        ...extracted,
      });
      logger.info(
        {
          route: "agentChat.extractAttachments",
          name,
          type,
          kind,
          size: attachment.size,
          extractStatus: extracted.extractStatus,
          extractedTextLength: extracted.extractedText?.length ?? 0,
          extractError: extracted.extractError,
        },
        "agent_chat_extracted_attachment",
      );
    }

    return extractedAttachments;
  }

  async createOpenAiCompatibleStream(
    input: AgentChatStreamInput,
  ): Promise<Response> {
    const streamStartedAt = Date.now();
    const sessionKey = buildWorkbenchSessionKey(input.agentId, input.sessionId);
    const runId = randomUUID();
    const requestRoute = normalizeRequestRoute(input.requestRoute);
    const imageAttachments = normalizeImageAttachments(input.attachments);
    const savedFiles = await this.saveWorkbenchFiles({
      agentId: input.agentId,
      sessionId: input.sessionId,
      attachments: input.attachments,
    });
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const requestedExecutionMode = normalizeExecutionMode(input.executionMode);
    const executionMode = requestedExecutionMode;
    const extraSystemPrompt = buildWorkbenchSystemPrompt({
      permissionMode,
      executionMode,
      requestRoute,
    });
    const userMessage = input.message;
    const shouldBufferPreToolText =
      requestRoute === "image_generation" ||
      requestRoute === "write_agent" ||
      requestRoute === "chat";
    const message = buildAgentMessage({
      message: appendSavedFileReferences({
        message: input.message,
        files: savedFiles,
      }),
      permissionMode,
      executionMode,
      requestRoute,
    });
    logger.info(
      {
        route: "agentChat.stream",
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey,
        runId,
        modelId: input.modelId ?? null,
        requestRoute,
        permissionMode,
        requestedExecutionMode,
        executionMode,
        attachmentCount: input.attachments?.length ?? 0,
        savedFileCount: savedFiles.length,
        imageAttachmentCount: imageAttachments?.length ?? 0,
      },
      "agent_chat_stream_openclaw_send",
    );
    const queuedChunks: Uint8Array[] = [];
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let lastText = "";
    let bufferedPreToolText = "";
    let settled = false;
    let firstMatchingEventLogged = false;
    let firstTextLogged = false;
    let firstToolActivityLogged = false;
    let toolActivitySeen = false;
    let activeRunId: string | null = runId;
    let waitingForSessionContinuation = false;
    let autoContinueTurns = 0;
    let emptyFinalRetries = 0;
    let pendingError: Error | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let keepalive: NodeJS.Timeout | null = null;
    let emptyFinalRetryTimeout: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    let preflightMs: number | null = null;
    let gatewayWaitMs: number | null = null;
    let submitMs: number | null = null;
    let firstTextMs: number | null = null;
    let lastErrorCategory: AgentChatErrorCategory | null = null;

    const sendAgentRun = async (
      requestRunId: string,
      requestMessage: string,
    ): Promise<void> => {
      await this.wsClient.request(
        "agent",
        {
          sessionKey,
          message: requestMessage,
          thinking: "off",
          deliver: false,
          extraSystemPrompt,
          bootstrapContextMode: "lightweight",
          idempotencyKey: requestRunId,
          ...(imageAttachments ? { attachments: imageAttachments } : {}),
        },
        { timeoutMs: AGENT_CHAT_TIMEOUT_MS },
      );
    };

    const enqueue = (chunk: Uint8Array) => {
      if (settled) {
        return;
      }
      if (controllerRef) {
        controllerRef.enqueue(chunk);
        return;
      }
      queuedChunks.push(chunk);
    };

    const logLatencySummary = (outcome: "finish" | "fail") => {
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          requestRoute,
          outcome,
          preflightMs,
          gatewayWaitMs,
          submitMs,
          firstTextMs,
          finishMs: Date.now() - streamStartedAt,
          inputChars: message.length,
          savedFileCount: savedFiles.length,
          autoContinueTurns,
          emptyFinalRetries,
          errorCategory: lastErrorCategory,
        },
        "agent_chat_latency_summary",
      );
    };

    const finish = () => {
      if (settled) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      if (emptyFinalRetryTimeout) {
        clearTimeout(emptyFinalRetryTimeout);
        emptyFinalRetryTimeout = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          elapsedMs: Date.now() - streamStartedAt,
          textLength: lastText.length,
          autoContinueTurns,
          toolActivitySeen,
        },
        "agent_chat_stream_finish",
      );
      logLatencySummary("finish");
      try {
        if (controllerRef) {
          controllerRef.enqueue(toDoneChunk());
        } else {
          queuedChunks.push(toDoneChunk());
        }
      } catch {
        // Stream may already be cancelled by the browser.
      }
      settled = true;
      try {
        controllerRef?.close();
      } catch {
        // Stream may already be cancelled by the browser.
      }
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      if (emptyFinalRetryTimeout) {
        clearTimeout(emptyFinalRetryTimeout);
        emptyFinalRetryTimeout = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      logger.warn(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          elapsedMs: Date.now() - streamStartedAt,
          error: error.message,
          errorCategory: classifyAgentChatErrorMessage(error.message),
        },
        "agent_chat_stream_fail",
      );
      logLatencySummary("fail");
      if (controllerRef) {
        controllerRef.error(error);
      } else {
        pendingError = error;
      }
    };

    const enqueueTextDelta = (delta: string) => {
      enqueue(
        toSseChunk({
          choices: [{ delta: { content: delta } }],
        }),
      );
    };

    const logFirstTextIfNeeded = (textLength: number) => {
      if (firstTextLogged) {
        return;
      }
      firstTextLogged = true;
      firstTextMs = Date.now() - streamStartedAt;
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          elapsedMs: firstTextMs,
          textLength,
        },
        "agent_chat_first_text",
      );
    };

    const flushBufferedPreToolText = () => {
      if (!bufferedPreToolText) {
        return;
      }
      logFirstTextIfNeeded(lastText.length);
      enqueueTextDelta(bufferedPreToolText);
      bufferedPreToolText = "";
    };

    const discardBufferedPreToolText = () => {
      if (!bufferedPreToolText) {
        return;
      }
      bufferedPreToolText = "";
      lastText = "";
    };

    const writeText = (nextText: string, options?: { force?: boolean }) => {
      if (!nextText) {
        return;
      }

      const normalizedNextText = cleanAssistantText(nextText);
      const delta =
        normalizedNextText.startsWith(lastText) &&
        normalizedNextText.length >= lastText.length
          ? normalizedNextText.slice(lastText.length)
          : normalizedNextText;
      lastText = normalizedNextText;

      if (!delta) {
        return;
      }

      if (shouldBufferPreToolText && !options?.force && !toolActivitySeen) {
        bufferedPreToolText += delta;
        return;
      }

      logFirstTextIfNeeded(normalizedNextText.length);
      enqueueTextDelta(delta);
    };

    const noteToolActivity = (eventName: string) => {
      toolActivitySeen = true;
      flushBufferedPreToolText();
      if (firstToolActivityLogged) {
        return;
      }
      firstToolActivityLogged = true;
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          eventName,
          elapsedMs: Date.now() - streamStartedAt,
        },
        "agent_chat_tool_activity",
      );
    };

    const handleChatEvent = (event: OpenClawGatewayEvent) => {
      if (event.event !== "chat") {
        if (
          extractSessionKey(event.payload) === sessionKey &&
          isToolActivityEvent(event)
        ) {
          noteToolActivity(event.event);
        }
        return;
      }

      const payload = asChatPayload(event.payload);
      if (!payload) {
        return;
      }
      if (payload.sessionKey !== sessionKey) {
        return;
      }

      const state = typeof payload.state === "string" ? payload.state : "";
      const payloadRunId =
        typeof payload.runId === "string" ? payload.runId : null;
      const messageText = extractMessageText(payload.message);
      if (isToolActivityEvent(event)) {
        noteToolActivity(event.event);
      }
      const isActiveRun =
        payloadRunId === null ||
        payloadRunId === runId ||
        payloadRunId === activeRunId;
      if (!isActiveRun) {
        if (waitingForSessionContinuation && messageText) {
          activeRunId = payloadRunId;
          waitingForSessionContinuation = false;
          if (emptyFinalRetryTimeout) {
            clearTimeout(emptyFinalRetryTimeout);
            emptyFinalRetryTimeout = null;
          }
          logger.info(
            {
              route: "agentChat.stream",
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey,
              runId,
              adoptedRunId: payloadRunId,
              state,
              elapsedMs: Date.now() - streamStartedAt,
            },
            "agent_chat_adopt_session_run",
          );
        } else {
          return;
        }
      }

      if (!firstMatchingEventLogged) {
        firstMatchingEventLogged = true;
        logger.info(
          {
            route: "agentChat.stream",
            agentId: input.agentId,
            sessionId: input.sessionId,
            sessionKey,
            runId,
            state,
            elapsedMs: Date.now() - streamStartedAt,
          },
          "agent_chat_first_openclaw_event",
        );
      }
      if (state === "delta") {
        writeText(messageText);
        return;
      }

      if (state === "final") {
        writeText(messageText);
        if (!lastText) {
          if (emptyFinalRetries < AGENT_CHAT_EMPTY_FINAL_RETRY_MAX_TURNS) {
            emptyFinalRetries += 1;
            const continuationRunId = randomUUID();
            activeRunId = continuationRunId;
            waitingForSessionContinuation = true;
            const emptyFinalRetryMessage =
              savedFiles.length > 0
                ? buildEmptyAttachmentRetryPrompt({
                    userMessage,
                    files: savedFiles,
                  })
                : `${buildAutoContinuePrompt(
                    executionMode,
                  )}\n\n上一轮没有产生可见回复。请继续执行并直接给出可见结果；如果存在真实阻塞，请明确说明阻塞原因与所需输入。\n\n用户原始任务：${userMessage}`;
            logger.info(
              {
                route: "agentChat.stream",
                agentId: input.agentId,
                sessionId: input.sessionId,
                sessionKey,
                runId,
                continuationRunId,
                savedFileCount: savedFiles.length,
                emptyFinalRetries,
                eventRunId: payloadRunId,
                elapsedMs: Date.now() - streamStartedAt,
              },
              savedFiles.length > 0
                ? "agent_chat_empty_attachment_retry_start"
                : "agent_chat_empty_final_retry_start",
            );
            void sendAgentRun(continuationRunId, emptyFinalRetryMessage)
              .then(() => {
                logger.info(
                  {
                    route: "agentChat.stream",
                    agentId: input.agentId,
                    sessionId: input.sessionId,
                    sessionKey,
                    runId,
                    continuationRunId,
                    emptyFinalRetries,
                    elapsedMs: Date.now() - streamStartedAt,
                  },
                  savedFiles.length > 0
                    ? "agent_chat_empty_attachment_retry_sent"
                    : "agent_chat_empty_final_retry_sent",
                );
              })
              .catch((error) => {
                logger.warn(
                  {
                    route: "agentChat.stream",
                    agentId: input.agentId,
                    sessionId: input.sessionId,
                    sessionKey,
                    runId,
                    continuationRunId,
                    emptyFinalRetries,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  savedFiles.length > 0
                    ? "agent_chat_empty_attachment_retry_failed"
                    : "agent_chat_empty_final_retry_failed",
                );
                finish();
              });
            return;
          }
          waitingForSessionContinuation = false;
          lastErrorCategory = "unknown";
          writeText(AGENT_CHAT_EMPTY_RESPONSE_MESSAGE, { force: true });
          logger.warn(
            {
              route: "agentChat.stream",
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey,
              runId,
              eventRunId: payloadRunId,
              emptyFinalRetries,
              errorCategory: lastErrorCategory,
              elapsedMs: Date.now() - streamStartedAt,
            },
            "agent_chat_empty_final_exhausted",
          );
          finish();
          return;
        }
        if (
          shouldAutoContinueFinal({
            finalText: messageText,
            autoContinueTurns,
            userMessage,
            savedFileCount: savedFiles.length,
            maxTurns: AGENT_CHAT_PROGRESS_AUTO_CONTINUE_MAX_TURNS,
          })
        ) {
          discardBufferedPreToolText();
          autoContinueTurns += 1;
          const continuationRunId = randomUUID();
          activeRunId = continuationRunId;
          waitingForSessionContinuation = true;
          logger.info(
            {
              route: "agentChat.stream",
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey,
              runId,
              continuationRunId,
              autoContinueTurns,
              toolActivitySeen,
              finalTextLength: cleanAssistantText(messageText).trim().length,
              elapsedMs: Date.now() - streamStartedAt,
            },
            "agent_chat_auto_continue_start",
          );
          void sendAgentRun(
            continuationRunId,
            `${buildAutoContinuePrompt(executionMode)}\n\n上一条回复：${cleanAssistantText(
              messageText,
            ).trim()}`,
          )
            .then(() => {
              logger.info(
                {
                  route: "agentChat.stream",
                  agentId: input.agentId,
                  sessionId: input.sessionId,
                  sessionKey,
                  runId,
                  continuationRunId,
                  autoContinueTurns,
                  elapsedMs: Date.now() - streamStartedAt,
                },
                "agent_chat_auto_continue_sent",
              );
            })
            .catch((error) => {
              logger.warn(
                {
                  route: "agentChat.stream",
                  agentId: input.agentId,
                  sessionId: input.sessionId,
                  sessionKey,
                  runId,
                  continuationRunId,
                  autoContinueTurns,
                  error: error instanceof Error ? error.message : String(error),
                },
                "agent_chat_auto_continue_failed",
              );
              finish();
            });
          return;
        }
        flushBufferedPreToolText();
        finish();
        return;
      }

      if (state === "aborted") {
        const text = messageText;
        if (text) {
          writeText(text);
        }
        finish();
        return;
      }

      if (state === "error") {
        const rawErrorMessage =
          typeof payload.errorMessage === "string"
            ? payload.errorMessage
            : "OpenClaw agent chat failed";
        lastErrorCategory = classifyAgentChatErrorMessage(rawErrorMessage);
        const errorMessage = normalizeAgentChatUserMessage(rawErrorMessage);
        if (isUserFacingAgentError(errorMessage)) {
          writeText(errorMessage, { force: true });
          finish();
          return;
        }
        fail(new Error(errorMessage));
      }
    };

    timeout = setTimeout(() => {
      fail(new Error("OpenClaw agent chat timed out"));
    }, AGENT_CHAT_TIMEOUT_MS);
    timeout.unref?.();

    unsubscribe = this.wsClient.onEvent(handleChatEvent);

    input.signal?.addEventListener(
      "abort",
      () => {
        void this.wsClient
          .request("chat.abort", { sessionKey, runId }, { timeoutMs: 5000 })
          .catch((error) => {
            logger.warn(
              {
                error: error instanceof Error ? error.message : String(error),
                sessionKey,
                runId,
              },
              "agent_chat_abort_failed",
            );
          });
        finish();
      },
      { once: true },
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(toSseComment("openclaw-stream-open"));
        if (pendingError) {
          controller.error(pendingError);
          return;
        }
        if (!settled) {
          keepalive = setInterval(() => {
            enqueue(toSseComment("openclaw-stream-keepalive"));
          }, AGENT_CHAT_STREAM_KEEPALIVE_MS);
          keepalive.unref?.();
        }
        for (const chunk of queuedChunks.splice(0)) {
          controller.enqueue(chunk);
        }
        if (settled) {
          controller.close();
        }
      },
      cancel: () => {
        void this.wsClient
          .request("chat.abort", { sessionKey, runId }, { timeoutMs: 5000 })
          .catch(() => {});
        finish();
      },
    });

    void (async () => {
      if (this.preflightSyncService) {
        const currentSync =
          this.preflightSyncService.getCurrentSyncPromise?.() ??
          this.preflightSyncPromise;
        const syncStatus = this.preflightSyncService.getSyncStatus?.();
        const shouldSync =
          Boolean(currentSync) || !syncStatus || !syncStatus.hasSuccessfulSync;

        if (!shouldSync) {
          logger.info(
            {
              route: "agentChat.stream",
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey,
              runId,
              lastSuccessfulSyncAt: syncStatus.lastSuccessfulSyncAt,
            },
            "agent_chat_preflight_sync_skipped",
          );
        } else {
          const syncStartedAt = Date.now();
          const waitingExistingSync = Boolean(currentSync);
          try {
            let syncPromise = currentSync ?? this.preflightSyncPromise;
            if (!syncPromise) {
              syncPromise = this.preflightSyncService.syncAllImmediate();
              this.preflightSyncPromise = syncPromise;
            }
            const result = await syncPromise;
            preflightMs = Date.now() - syncStartedAt;
            logger.info(
              {
                route: "agentChat.stream",
                agentId: input.agentId,
                sessionId: input.sessionId,
                sessionKey,
                runId,
                configPushed: result.configPushed,
                waitingExistingSync,
                elapsedMs: preflightMs,
              },
              "agent_chat_preflight_sync_complete",
            );
          } catch (error) {
            preflightMs = Date.now() - syncStartedAt;
            logger.warn(
              {
                route: "agentChat.stream",
                agentId: input.agentId,
                sessionId: input.sessionId,
                sessionKey,
                runId,
                error: error instanceof Error ? error.message : String(error),
                waitingExistingSync,
                elapsedMs: preflightMs,
              },
              "agent_chat_preflight_sync_failed",
            );
            throw new Error(OPENCLAW_CONFIG_SYNC_FAILED_MESSAGE);
          } finally {
            if (!currentSync) {
              this.preflightSyncPromise = null;
            }
          }
        }
      }

      const gatewayWaitStartedAt = Date.now();
      while (!this.wsClient.isConnected()) {
        if (
          Date.now() - gatewayWaitStartedAt >=
          OPENCLAW_GATEWAY_READY_TIMEOUT_MS
        ) {
          throw new Error("openclaw gateway not connected");
        }
        await sleep(OPENCLAW_GATEWAY_READY_POLL_MS, input.signal);
      }

      gatewayWaitMs = Date.now() - gatewayWaitStartedAt;
      if (gatewayWaitMs > 0) {
        logger.info(
          {
            route: "agentChat.stream",
            agentId: input.agentId,
            sessionId: input.sessionId,
            sessionKey,
            runId,
            elapsedMs: gatewayWaitMs,
          },
          "agent_chat_gateway_ready",
        );
      }

      const wsRequestStartedAt = Date.now();
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
        },
        "agent_chat_ws_request_start",
      );
      await sendAgentRun(runId, message);
      submitMs = Date.now() - wsRequestStartedAt;
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          elapsedMs: submitMs,
        },
        "agent_chat_ws_request_done",
      );
    })().catch((error) => {
      const rawMessage =
        error instanceof Error ? error.message : "OpenClaw agent chat failed";
      lastErrorCategory = classifyAgentChatErrorMessage(rawMessage);
      const message = normalizeAgentChatUserMessage(rawMessage);
      logger.warn(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          error: message,
          errorCategory: lastErrorCategory,
        },
        "agent_chat_send_failed",
      );
      if (!lastText) {
        if (isUserFacingAgentError(message)) {
          writeText(message, { force: true });
          finish();
        } else {
          fail(new Error(message));
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private async saveWorkbenchFiles(input: {
    agentId: string;
    sessionId: string;
    attachments: readonly AgentChatAttachment[] | undefined;
  }): Promise<SavedWorkbenchFile[]> {
    const files = (input.attachments ?? []).filter(
      (attachment) => attachment.dataUrl,
    );
    if (files.length === 0) {
      return [];
    }

    const uploadDir = path.join(
      this.env.openclawStateDir,
      "agents",
      sanitizeSessionPart(input.agentId || "main"),
      "wb",
      createHash("sha256").update(input.sessionId).digest("hex").slice(0, 16),
    );
    await mkdir(uploadDir, { recursive: true });

    const saved: SavedWorkbenchFile[] = [];
    for (const attachment of files) {
      const parsed = parseDataUrl(attachment.dataUrl ?? "");
      if (!parsed?.content) {
        continue;
      }

      const name = sanitizeFileName(attachment.name || "attachment");
      const content = Buffer.from(parsed.content, "base64");
      const targetPath = path.join(uploadDir, buildShortUploadName(name));
      await writeFile(targetPath, content);
      const extracted = await extractAttachmentText({
        name,
        type: attachment.type || parsed.mimeType,
        kind: attachment.kind || "file",
        content,
      });
      const savedFile = {
        name,
        path: targetPath,
        type: attachment.type || parsed.mimeType,
        kind: attachment.kind || "file",
        ...extracted,
      };
      saved.push(savedFile);
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          name: savedFile.name,
          type: savedFile.type,
          kind: savedFile.kind,
          path: savedFile.path,
          extractStatus: savedFile.extractStatus,
          extractedTextLength: savedFile.extractedText?.length ?? 0,
          extractError: savedFile.extractError,
        },
        "agent_chat_saved_workbench_attachment",
      );
    }

    return saved;
  }
}

function sanitizeFileName(value: string): string {
  const base = [...path.basename(value).replace(/[<>:"/\\|?*]/gu, "_")]
    .map((char) => (char.charCodeAt(0) < 32 ? "_" : char))
    .join("");
  return base.trim().slice(0, 120) || "attachment";
}

function buildShortUploadName(value: string): string {
  const sanitized = sanitizeFileName(value);
  const ext = path.extname(sanitized).slice(0, 16);
  const stem = path.basename(sanitized, ext).slice(0, 24) || "attachment";
  const shortId = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${Date.now().toString(36)}-${shortId}-${stem}${ext}`;
}

function appendSavedFileReferences(input: {
  message: string;
  files: ReadonlyArray<SavedWorkbenchFile>;
}): string {
  if (input.files.length === 0) {
    return input.message;
  }

  const hasImages = input.files.some((file) => file.kind === "image");
  return [
    input.message,
    "工作台附件已保存到当前 OpenClaw agent workspace。若用户要求总结、分析、读取、处理附件，必须优先使用下列附件内容或文件路径，不要改去桌面搜索同名文件：",
    formatSavedFileList(input.files),
    hasImages
      ? "如果用户要求基于上传图片生图、改图或图生图，请把对应图片路径填入 image_generate.inputImages，不要留空。"
      : "",
  ].join("\n\n");
}

function formatSavedFileList(files: ReadonlyArray<SavedWorkbenchFile>): string {
  return files.map((file) => formatSavedFile(file)).join("\n\n");
}

function formatSavedFile(file: SavedWorkbenchFile): string {
  const lines = [`- ${file.name} (${file.kind}, ${file.type}): ${file.path}`];
  if (file.extractedText) {
    lines.push(
      `  提取状态：${file.extractStatus}`,
      "  已提取正文：",
      "  ```",
      indentAttachmentText(file.extractedText),
      "  ```",
    );
  } else {
    lines.push(
      `  提取状态：${file.extractStatus}`,
      `  提取说明：${file.extractError ?? "没有可用的提取文本。"}`,
    );
  }
  return lines.join("\n");
}

function indentAttachmentText(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
