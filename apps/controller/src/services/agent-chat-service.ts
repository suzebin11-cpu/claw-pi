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

const AGENT_CHAT_TIMEOUT_MS = 600_000;
const AGENT_CHAT_RETRY_TIMEOUT_MS = 90_000;
const AGENT_CHAT_HEARTBEAT_MS = 15_000;
const OPENCLAW_GATEWAY_READY_TIMEOUT_MS = 360_000;
const OPENCLAW_GATEWAY_READY_POLL_MS = 250;
const AGENT_CHAT_AUTO_CONTINUE_MAX_TURNS = 6;
const AGENT_CHAT_AUTO_CONTINUE_MAX_FINAL_CHARS = 1600;
const ATTACHMENT_EXTRACT_MAX_CHARS = 24_000;
const INSUFFICIENT_BALANCE_MESSAGE = "余额不足，请及时充值";
const AGENT_CHAT_AUTO_CONTINUE_PROMPT =
  "继续执行当前任务。不要只回复计划、状态或道歉；需要本机/文件/网页/生图操作时，立即调用 OpenClaw 可用工具完成。最终回复只能是完成结果、产物路径/图片链接，或明确阻塞原因与所需输入。";
const AGENT_CHAT_EMPTY_ATTACHMENT_RETRY_PROMPT =
  "上一轮没有产生可见回复。当前任务包含工作台上传附件：必须优先使用下列附件正文或文件路径完成用户任务。不要只回复计划、状态或道歉；最终直接给出结果，或明确说明真实阻塞原因。";
const GENERATED_IMAGE_URL_PATTERN =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif)/iu;
const WORKBENCH_ACTION_REQUEST_PATTERNS = [
  /(?:桌面|onedrive|本机|电脑|文件|目录|路径|pdf|excel|word|ppt|简历|安装包|应用|网页|浏览器|截图|图片|生图|改图|图生图|claw-?pi|龙虾工作台)/iu,
  /(?:打开|创建|新建|写入|保存|读取|查找|搜索|定位|提取|总结|分析|运行|执行|重启|安装|下载|生成|处理|修复|验证|测试|修改|编辑|添加|新增|插入|追加|补充|填入|录入|登记|更新|替换)(?:[^。！？.!?\n]{0,40})(?:文件|目录|路径|桌面|电脑|本机|网页|应用|图片|简历|pdf|excel|word|ppt|表格|行|列|记录)/iu,
  /(?:帮我|请|麻烦|替我|为我)(?:[^。！？.!?\n]{0,60})(?:找|查|搜|打开|创建|新建|读取|提取|总结|分析|运行|执行|重启|安装|下载|生成|生图|改图|处理|修复|验证|测试|修改|编辑|添加|新增|插入|追加|补充|填入|录入|登记|更新|替换|加一行)/iu,
  /^(?:继续|接着|继续处理|继续执行|好的继续|然后呢|然后|是的|好的)$/iu,
  /\b(?:open|create|write|save|read|find|search|locate|extract|summarize|analyze|run|execute|restart|install|download|generate|process|fix|verify|test|modify|edit|add|insert|append|update|replace)\b(?:[^.!?\n]{0,60})\b(?:file|folder|path|desktop|computer|pdf|excel|word|ppt|image|browser|app|table|row|column|record)\b/iu,
];
const WRITE_EXECUTION_INTENT_PATTERNS = [
  /(?:创建|新建|写入|保存|另存|导出|修改|编辑|删除|移动|复制|重命名|替换|覆盖|更新|改成)/iu,
  /(?:添加|新增|插入|追加|补充|填入|录入|登记|加(?:上|入|到|一行|一列|一条)?)(?:[^。！？.!?\n]{0,80})(?:行|列|数据|记录|表格|excel|xlsx|csv|文件|文档|手机号|电话|名称|名字|地址)/iu,
  /\b(?:create|write|save|export|modify|edit|delete|move|copy|rename|replace|update|add|insert|append)\b/iu,
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
    .replace(/\u0000/gu, "")
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
  mode: AgentPermissionMode | null | undefined,
): AgentPermissionMode {
  if (mode === "basic" || mode === "confirm" || mode === "full") {
    return mode;
  }
  return "full";
}

function normalizeExecutionMode(
  mode: AgentExecutionMode | null | undefined,
): AgentExecutionMode {
  return mode === "read_only" ? "read_only" : "write";
}

function hasExplicitWriteIntent(message: string): boolean {
  const normalized = message.replace(/\s+/gu, " ").trim();
  return WRITE_EXECUTION_INTENT_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function resolveEffectiveExecutionMode(input: {
  requestedExecutionMode: AgentExecutionMode;
  permissionMode: AgentPermissionMode;
  message: string;
}): AgentExecutionMode {
  if (
    input.requestedExecutionMode === "read_only" &&
    input.permissionMode !== "basic" &&
    hasExplicitWriteIntent(input.message)
  ) {
    return "write";
  }

  return input.requestedExecutionMode;
}

function isInsufficientBalanceError(message: string): boolean {
  return /(?:token quota is not enough|need quota|insufficient (?:balance|quota|credits?)|quota.+not enough|余额不足|额度不足|余额不够|充值)/iu.test(
    message,
  );
}

function normalizeAgentErrorMessage(message: string): string {
  return isInsufficientBalanceError(message)
    ? INSUFFICIENT_BALANCE_MESSAGE
    : message;
}

function buildAutoContinuePrompt(executionMode: AgentExecutionMode): string {
  if (executionMode === "read_only") {
    return `${AGENT_CHAT_AUTO_CONTINUE_PROMPT}\n当前是只读分析模式：不要创建、写入、保存或导出文件，结果直接回复在聊天里。`;
  }
  return AGENT_CHAT_AUTO_CONTINUE_PROMPT;
}

function buildEmptyAttachmentRetryPrompt(input: {
  userMessage: string;
  executionMode: AgentExecutionMode;
  files: ReadonlyArray<SavedWorkbenchFile>;
  permissionMode: AgentPermissionMode;
}): string {
  return [
    AGENT_CHAT_EMPTY_ATTACHMENT_RETRY_PROMPT,
    input.executionMode === "read_only"
      ? "当前是只读分析模式：只读取和分析附件，不要创建、写入、保存或导出文件。"
      : "除非用户明确要求，不要额外创建、保存或导出文件。",
    input.permissionMode === "basic" ? "上传附件内容：" : "上传附件：",
    formatSavedFileList(input.files, input.permissionMode),
    "用户原始任务：",
    input.userMessage,
  ].join("\n\n");
}

function buildPermissionDirective(mode: AgentPermissionMode): string {
  if (mode === "basic") {
    return [
      "权限=基础：可问答、分析本轮附件、生成图片。",
      "不要读取/写入本机文件、打开应用、执行命令或访问用户未提供的本机路径。",
      "如需电脑执行权，提示用户切到执行确认或完全访问。",
    ].join("\n");
  }

  if (mode === "confirm") {
    return [
      "权限=执行确认：涉及本机读写、打开应用、执行脚本、联网操作或长期任务前，先说明动作并等待确认。",
      "确认后使用可用工具完成任务。",
    ].join("\n");
  }

  return [
    "权限=完全访问：用户要求操作电脑、读写文件、打开网页/应用、创建文件或处理本机资料时，直接使用可用工具执行。",
    "可用工具包含 read/write/edit/exec/web_search/image_generate 等时，除非真实失败，不要声称无法直接操作。",
    "上传文件优先使用工作台提供的本机路径；破坏性或不可逆操作仍需先确认。",
  ].join("\n");
}

function buildWorkbenchSystemPrompt(input: {
  permissionMode: AgentPermissionMode;
  executionMode: AgentExecutionMode;
}): string {
  return [
    "你是 OpenClaw 龙虾 agent，必须通过 OpenClaw runner 完成工作台任务；不要退化成普通聊天模型。",
    "这是龙虾工作台的直接对话请求，优先回答用户当前消息。",
    input.executionMode === "read_only"
      ? [
          "执行模式=只读分析：用户只要求查找、读取、提取、总结或分析时，只允许读取/搜索/解析已有资料。",
          "不要创建、写入、编辑、保存、导出或覆盖任何用户文件；用户没有明确要求写文件时，最终结果必须直接回复在聊天里。",
          "如确需临时脚本解析文件，只能用于读取和提取内容，不得把总结另存为文件。",
        ].join("\n")
      : [
          "执行模式=可写执行：只有用户明确要求创建、保存、导出、修改、删除、运行、安装、打开应用或生成图片/文件时，才进行对应写入或执行操作。",
          "不要额外创建用户没有要求的文件；如果任务只是总结/分析，结果直接回复在聊天里。",
        ].join("\n"),
    "如果用户要求查找/读取/处理本机文件、运行命令、打开网页/应用、生成或修改图片，必须先调用可用工具执行；不要把“我会/我先/我正在/我准备”这类计划或进度说明作为最终答复。",
    "最终答复必须包含实际结果、产物路径/图片链接，或明确阻塞原因与所需输入；任务没完成时继续执行。",
    buildPermissionDirective(input.permissionMode),
  ].join("\n\n");
}

function buildAgentMessage(input: {
  message: string;
  permissionMode: AgentPermissionMode;
  executionMode: AgentExecutionMode;
}): string {
  return [
    "以下为龙虾工作台注入的运行约束，优先级高于用户当前消息：",
    buildWorkbenchSystemPrompt({
      permissionMode: input.permissionMode,
      executionMode: input.executionMode,
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

  const details = isObject(value.details) ? value.details : null;
  if (details) {
    const detailsMarkdown = extractGeneratedImageText(details);
    if (detailsMarkdown) {
      return detailsMarkdown;
    }
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

function isLikelyWorkbenchActionRequest(input: {
  userMessage: string;
  permissionMode: AgentPermissionMode;
  savedFileCount: number;
}): boolean {
  if (input.permissionMode === "basic") {
    return false;
  }

  if (input.savedFileCount > 0) {
    return true;
  }

  const normalized = input.userMessage.replace(/\s+/gu, " ").trim();
  return WORKBENCH_ACTION_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function shouldAutoContinueFinal(input: {
  finalText: string;
  autoContinueTurns: number;
  userMessage: string;
  permissionMode: AgentPermissionMode;
  savedFileCount: number;
  toolActivitySeen: boolean;
}): boolean {
  if (input.autoContinueTurns >= AGENT_CHAT_AUTO_CONTINUE_MAX_TURNS) {
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

  const isActionRequest = isLikelyWorkbenchActionRequest({
    userMessage: input.userMessage,
    permissionMode: input.permissionMode,
    savedFileCount: input.savedFileCount,
  });
  if (
    !isActionRequest &&
    !input.toolActivitySeen &&
    input.permissionMode === "basic"
  ) {
    return false;
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
  constructor(
    private readonly wsClient: OpenClawWsClient,
    private readonly env: ControllerEnv,
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
    const imageAttachments = normalizeImageAttachments(input.attachments);
    const savedFiles = await this.saveWorkbenchFiles({
      agentId: input.agentId,
      sessionId: input.sessionId,
      attachments: input.attachments,
    });
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const requestedExecutionMode = normalizeExecutionMode(input.executionMode);
    const executionMode = resolveEffectiveExecutionMode({
      requestedExecutionMode,
      permissionMode,
      message: input.message,
    });
    const extraSystemPrompt = buildWorkbenchSystemPrompt({
      permissionMode,
      executionMode,
    });
    const userMessage = input.message;
    const message = buildAgentMessage({
      message: appendSavedFileReferences({
        message: input.message,
        files: savedFiles,
        permissionMode,
      }),
      permissionMode,
      executionMode,
    });
    logger.info(
      {
        route: "agentChat.stream",
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey,
        runId,
        modelId: input.modelId ?? null,
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
    let settled = false;
    let firstMatchingEventLogged = false;
    let firstTextLogged = false;
    let firstToolActivityLogged = false;
    let toolActivitySeen = false;
    let generatedImageMarkdown = "";
    let activeRunId: string | null = runId;
    let waitingForSessionContinuation = false;
    let autoContinueTurns = 0;
    let pendingError: Error | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let emptyFinalRetryTimeout: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeDisconnected: (() => void) | null = null;

    const clearEmptyFinalRetryTimeout = () => {
      if (emptyFinalRetryTimeout) {
        clearTimeout(emptyFinalRetryTimeout);
        emptyFinalRetryTimeout = null;
      }
    };

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

    const finish = () => {
      if (settled) {
        return;
      }
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      clearEmptyFinalRetryTimeout();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeDisconnected?.();
      unsubscribeDisconnected = null;
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
      clearEmptyFinalRetryTimeout();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeDisconnected?.();
      unsubscribeDisconnected = null;
      logger.warn(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          elapsedMs: Date.now() - streamStartedAt,
          error: error.message,
        },
        "agent_chat_stream_fail",
      );
      if (controllerRef) {
        try {
          controllerRef.enqueue(
            toSseChunk({
              error: {
                message: error.message,
                type: "agent_chat_error",
              },
            }),
          );
          controllerRef.enqueue(
            toSseChunk({
              choices: [{ delta: {}, finish_reason: "error" }],
            }),
          );
          controllerRef.enqueue(toDoneChunk());
          controllerRef.close();
        } catch {
          // Stream may already be cancelled by the browser.
        }
      } else {
        pendingError = error;
      }
    };

    const writeText = (nextText: string) => {
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

      if (!firstTextLogged) {
        firstTextLogged = true;
        logger.info(
          {
            route: "agentChat.stream",
            agentId: input.agentId,
            sessionId: input.sessionId,
            sessionKey,
            runId,
            elapsedMs: Date.now() - streamStartedAt,
            textLength: normalizedNextText.length,
          },
          "agent_chat_first_text",
        );
      }

      enqueue(
        toSseChunk({
          choices: [{ delta: { content: delta } }],
        }),
      );
    };

    const noteToolActivity = (eventName: string) => {
      toolActivitySeen = true;
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
      const messageImageMarkdown = isObject(payload.message)
        ? extractGeneratedImageText(payload.message)
        : "";
      if (messageImageMarkdown) {
        generatedImageMarkdown = messageImageMarkdown;
      }
      if (isToolActivityEvent(event)) {
        noteToolActivity(event.event);
      }
      const isActiveRun =
        payloadRunId === null ||
        payloadRunId === runId ||
        payloadRunId === activeRunId;
      if (
        isActiveRun &&
        waitingForSessionContinuation &&
        payloadRunId === activeRunId
      ) {
        waitingForSessionContinuation = false;
        clearEmptyFinalRetryTimeout();
      }
      if (!isActiveRun) {
        if (
          waitingForSessionContinuation &&
          payloadRunId &&
          ["delta", "final", "error", "aborted"].includes(state)
        ) {
          activeRunId = payloadRunId;
          waitingForSessionContinuation = false;
          clearEmptyFinalRetryTimeout();
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
          clearEmptyFinalRetryTimeout();
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
        if (
          generatedImageMarkdown &&
          !lastText.includes(generatedImageMarkdown)
        ) {
          writeText(generatedImageMarkdown);
          logger.info(
            {
              route: "agentChat.stream",
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey,
              runId,
              elapsedMs: Date.now() - streamStartedAt,
            },
            "agent_chat_image_fallback_extracted",
          );
        }
        if (!lastText) {
          // 特殊处理：检查工具返回中是否有生图结果
          // 即使 OpenClaw 没有在 final 文本中输出图片链接，也尝试从 payload 中提取
          const imageMarkdown = extractGeneratedImageText(
            isObject(payload.message) ? payload.message : {},
          );
          if (imageMarkdown) {
            writeText(imageMarkdown);
            logger.info(
              {
                route: "agentChat.stream",
                agentId: input.agentId,
                sessionId: input.sessionId,
                sessionKey,
                runId,
                elapsedMs: Date.now() - streamStartedAt,
              },
              "agent_chat_image_fallback_extracted",
            );
            finish();
            return;
          }

          if (autoContinueTurns < AGENT_CHAT_AUTO_CONTINUE_MAX_TURNS) {
            autoContinueTurns += 1;
            const continuationRunId = randomUUID();
            activeRunId = continuationRunId;
            waitingForSessionContinuation = true;
            const emptyFinalRetryMessage =
              savedFiles.length > 0
                ? buildEmptyAttachmentRetryPrompt({
                    userMessage,
                    executionMode,
                    files: savedFiles,
                    permissionMode,
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
                autoContinueTurns,
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
                    autoContinueTurns,
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
                    autoContinueTurns,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  savedFiles.length > 0
                    ? "agent_chat_empty_attachment_retry_failed"
                    : "agent_chat_empty_final_retry_failed",
                );
                fail(
                  error instanceof Error
                    ? error
                    : new Error(String(error)),
                );
              });
            emptyFinalRetryTimeout = setTimeout(() => {
              fail(
                new Error(
                  "OpenClaw agent returned no response while retrying the empty result",
                ),
              );
            }, AGENT_CHAT_RETRY_TIMEOUT_MS);
            emptyFinalRetryTimeout.unref?.();
            return;
          }
          waitingForSessionContinuation = false;
          logger.warn(
            {
              route: "agentChat.stream",
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey,
              runId,
              eventRunId: payloadRunId,
              autoContinueTurns,
              elapsedMs: Date.now() - streamStartedAt,
            },
            "agent_chat_empty_final_exhausted",
          );
          fail(
            new Error(
              "OpenClaw agent returned an empty response after retries",
            ),
          );
          return;
        }
        if (
          shouldAutoContinueFinal({
            finalText: messageText,
            autoContinueTurns,
            userMessage,
            permissionMode,
            savedFileCount: savedFiles.length,
            toolActivitySeen,
          })
        ) {
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
              fail(
                error instanceof Error
                  ? error
                  : new Error(String(error)),
              );
            });
          emptyFinalRetryTimeout = setTimeout(() => {
            fail(
              new Error(
                "OpenClaw agent continuation produced no response in time",
              ),
            );
          }, AGENT_CHAT_RETRY_TIMEOUT_MS);
          emptyFinalRetryTimeout.unref?.();
          return;
        }
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
        const errorMessage = normalizeAgentErrorMessage(
          typeof payload.errorMessage === "string"
            ? payload.errorMessage
            : "OpenClaw agent chat failed",
        );
        if (errorMessage === INSUFFICIENT_BALANCE_MESSAGE) {
          writeText(errorMessage);
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
    unsubscribeDisconnected = this.wsClient.onDisconnected(() => {
      if (!settled && activeRunId !== null && !waitingForSessionContinuation) {
        fail(new Error("OpenClaw gateway disconnected during agent chat"));
      }
    });

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
        heartbeat = setInterval(() => {
          if (!settled) {
            try {
              controller.enqueue(toSseComment("openclaw-stream-heartbeat"));
            } catch {
              // Stream may already be cancelled by the browser.
            }
          }
        }, AGENT_CHAT_HEARTBEAT_MS);
        heartbeat.unref?.();
        if (pendingError) {
          controller.enqueue(
            toSseChunk({
              error: {
                message: pendingError.message,
                type: "agent_chat_error",
              },
            }),
          );
          controller.enqueue(
            toSseChunk({
              choices: [{ delta: {}, finish_reason: "error" }],
            }),
          );
          controller.enqueue(toDoneChunk());
          clearInterval(heartbeat);
          heartbeat = null;
          controller.close();
          return;
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

      const gatewayWaitMs = Date.now() - gatewayWaitStartedAt;
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
      logger.info(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          elapsedMs: Date.now() - wsRequestStartedAt,
        },
        "agent_chat_ws_request_done",
      );
    })().catch((error) => {
      const message = normalizeAgentErrorMessage(
        error instanceof Error ? error.message : "OpenClaw agent chat failed",
      );
      logger.warn(
        {
          route: "agentChat.stream",
          agentId: input.agentId,
          sessionId: input.sessionId,
          sessionKey,
          runId,
          error: message,
        },
        "agent_chat_send_failed",
      );
      if (!lastText) {
        if (message === INSUFFICIENT_BALANCE_MESSAGE) {
          writeText(message);
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
  permissionMode: AgentPermissionMode;
}): string {
  if (input.files.length === 0) {
    return input.message;
  }

  const hasImages = input.files.some((file) => file.kind === "image");
  const basicMode = input.permissionMode === "basic";
  return [
    input.message,
    basicMode
      ? "工作台已接收上传附件。基础权限下不要读取本机路径；若下方已提取附件正文，直接基于正文完成总结、分析或问答："
      : "工作台附件已保存到当前 OpenClaw agent workspace。若用户要求总结、分析、读取、处理附件，必须优先使用下列附件内容或文件路径，不要改去桌面搜索同名文件：",
    formatSavedFileList(input.files, input.permissionMode),
    hasImages && !basicMode
      ? "如果用户要求基于上传图片生图、改图或图生图，请把对应图片路径填入 image_generate.inputImages，不要留空。"
      : "",
  ].join("\n\n");
}

function formatSavedFileList(
  files: ReadonlyArray<SavedWorkbenchFile>,
  permissionMode: AgentPermissionMode,
): string {
  const includePath = permissionMode !== "basic";
  return files.map((file) => formatSavedFile(file, includePath)).join("\n\n");
}

function formatSavedFile(
  file: SavedWorkbenchFile,
  includePath: boolean,
): string {
  const lines = [
    `- ${file.name} (${file.kind}, ${file.type})${includePath ? `: ${file.path}` : ""}`,
  ];
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
