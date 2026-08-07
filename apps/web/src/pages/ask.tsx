import { ModelPickerDropdown } from "@/components/model-picker-dropdown";
import { ChatMarkdown } from "@/components/ui/chat-markdown";
import "@/lib/api";
import {
  clearAskUnread,
  markAskReplyFinished,
  markAskReplyStarted,
  readAskActivity,
  subscribeAskActivity,
} from "@/lib/ask-activity";
import { copyImageToClipboard, downloadImage } from "@/lib/image-actions";
import {
  resolveBackendModelId,
  resolveDisplayModelId,
  subscribeModelDisplayChoice,
  withDisplayAliasModels,
} from "@/lib/model-display-alias";
import { useBootGrace } from "@/lib/runtime-startup";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  Globe2,
  ImageIcon,
  Loader2,
  Maximize2,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  Video,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  getApiInternalDesktopDefaultModel,
  getApiInternalDesktopReady,
  getApiV1Models,
  putApiInternalDesktopDefaultModel,
} from "../../lib/api/sdk.gen";

type Model = {
  id: string;
  name: string;
  provider: string;
};

type ChatRole = "user" | "assistant";

type AttachmentKind = "image" | "text" | "video" | "file";

type ChatAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: AttachmentKind;
  dataUrl?: string;
  text?: string;
  truncated?: boolean;
};

type MessageUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated?: boolean;
  costYuan?: number;
};

type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  attachments?: ChatAttachment[];
  streaming?: boolean;
  usage?: MessageUsage;
  modelLabel?: string;
  durationMs?: number;
};

type ChatSession = {
  id: string;
  title: string;
  titleSource?: "auto" | "manual";
  contextSummary?: string;
  summarizedThroughMessageId?: string;
  summaryUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type KnowledgeItem = {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

type PreviewImage = {
  src: string;
  name: string;
};

type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: "auto" } }
      >;
};

type LocalDesktopPermissionMode = "basic" | "confirm" | "full";
type WorkbenchRequestRoute =
  | "chat"
  | "image_generation"
  | "read_only_agent"
  | "write_agent";
type AgentExecutionMode = "read_only" | "write";

type LocalDesktopPermissionSettings = {
  mode: LocalDesktopPermissionMode;
};

type StreamedCompletionResult = {
  text: string;
  error?: string;
  finishReason?: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

const MAX_CONTEXT_MESSAGES = 20;
const COMPACTION_TRIGGER_MESSAGES = 24;
const COMPACTION_KEEP_RECENT_MESSAGES = 8;
const MAX_COMPACTION_SOURCE_CHARS = 24_000;
const MAX_CONTEXT_SUMMARY_CHARS = 4_000;
const MAX_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_STORED_SESSIONS = 40;
const MAX_PERSISTED_IMAGE_CHARS = 1_500_000;
const MAX_KNOWLEDGE_ITEMS = 40;
const MAX_KNOWLEDGE_CHARS = 18_000;
const MAX_KNOWLEDGE_CONTEXT_CHARS = 7_000;
const MAX_KNOWLEDGE_MATCHES = 4;
const ASK_SESSIONS_STORAGE_KEY = "claw-pi.ask.sessions.v1";
const ASK_ACTIVE_SESSION_STORAGE_KEY = "claw-pi.ask.activeSessionId.v1";
const ASK_KNOWLEDGE_STORAGE_KEY = "claw-pi.ask.knowledge.v1";
const ASK_LOCAL_PERMISSIONS_STORAGE_KEY = "claw-pi.ask.localPermissions.v1";
const INSUFFICIENT_BALANCE_MESSAGE = "余额不足，请及时充值";
const AGENT_HISTORY_CONTEXT_CHARS = 5_000;
const AGENT_HISTORY_CONTEXT_MESSAGES = 8;
const MAX_AGENT_WORKBENCH_CHARS = 20_000;

const DEFAULT_LOCAL_PERMISSIONS: LocalDesktopPermissionSettings = {
  mode: "full",
};

const TEXT_EXTENSIONS = new Set([
  "c",
  "cpp",
  "css",
  "csv",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "py",
  "rs",
  "sql",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const CHAT_MODEL_PRICING: Array<{
  matchIds: string[];
  inputPerM: number;
  outputPerM: number;
}> = [
  {
    matchIds: ["gemini-3.1-flash-lite-preview"],
    inputPerM: 0.25,
    outputPerM: 1.5,
  },
  { matchIds: ["gemini-3.1-pro-preview"], inputPerM: 2, outputPerM: 12 },
  { matchIds: ["claude-haiku-4-5"], inputPerM: 1, outputPerM: 5 },
  { matchIds: ["claude-sonnet-4-6"], inputPerM: 3, outputPerM: 15 },
  { matchIds: ["claude-opus-4-6"], inputPerM: 5, outputPerM: 25 },
  { matchIds: ["gpt-5.4-nano"], inputPerM: 0.2, outputPerM: 1.25 },
  { matchIds: ["gpt-5.4-mini"], inputPerM: 0.75, outputPerM: 4.5 },
  { matchIds: ["gpt-5.4"], inputPerM: 2.5, outputPerM: 15 },
  { matchIds: ["gpt-5.5", "gpt-5.6"], inputPerM: 5, outputPerM: 30 },
  { matchIds: ["deepseek-v4-flash"], inputPerM: 1, outputPerM: 2 },
  { matchIds: ["deepseek-v4-pro"], inputPerM: 12, outputPerM: 24 },
  { matchIds: ["grok-4.2-fast"], inputPerM: 0.4, outputPerM: 3 },
  { matchIds: ["grok-4.2"], inputPerM: 3, outputPerM: 15 },
];

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSession(defaultTitle: string): ChatSession {
  const now = Date.now();
  return {
    id: createId("ask"),
    title: defaultTitle,
    titleSource: "auto",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function buildSessionTitle(
  text: string,
  attachments: ChatAttachment[],
  fallback: string,
): string {
  const source =
    text.trim() ||
    attachments.find((attachment) => attachment.name.trim().length > 0)?.name ||
    fallback;
  return source.length > 24 ? `${source.slice(0, 24)}...` : source;
}

function sanitizeStoredMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    streaming: false,
    attachments: message.attachments?.map((attachment) => ({
      ...attachment,
      dataUrl:
        attachment.dataUrl &&
        attachment.dataUrl.length <= MAX_PERSISTED_IMAGE_CHARS
          ? attachment.dataUrl
          : undefined,
    })),
  };
}

function sanitizeStoredSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: session.messages.map(sanitizeStoredMessage),
  };
}

function isChatMessage(input: unknown): input is ChatMessage {
  if (!input || typeof input !== "object") return false;
  const candidate = input as Partial<ChatMessage>;
  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.text === "string" &&
    typeof candidate.createdAt === "number"
  );
}

function loadStoredSessions(defaultTitle: string): ChatSession[] {
  if (typeof window === "undefined") {
    return [createSession(defaultTitle)];
  }

  try {
    const raw = window.localStorage.getItem(ASK_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) {
      return [createSession(defaultTitle)];
    }

    const sessions = parsed
      .map((item): ChatSession | null => {
        if (!item || typeof item !== "object") return null;
        const candidate = item as Partial<ChatSession>;
        if (typeof candidate.id !== "string") return null;
        const messages = Array.isArray(candidate.messages)
          ? candidate.messages.filter(isChatMessage).map(sanitizeStoredMessage)
          : [];
        return {
          id: candidate.id,
          title:
            typeof candidate.title === "string" && candidate.title.trim()
              ? candidate.title
              : defaultTitle,
          titleSource: candidate.titleSource === "manual" ? "manual" : "auto",
          contextSummary:
            typeof candidate.contextSummary === "string"
              ? candidate.contextSummary.slice(0, MAX_CONTEXT_SUMMARY_CHARS)
              : undefined,
          summarizedThroughMessageId:
            typeof candidate.summarizedThroughMessageId === "string"
              ? candidate.summarizedThroughMessageId
              : undefined,
          summaryUpdatedAt:
            typeof candidate.summaryUpdatedAt === "number"
              ? candidate.summaryUpdatedAt
              : undefined,
          createdAt:
            typeof candidate.createdAt === "number"
              ? candidate.createdAt
              : Date.now(),
          updatedAt:
            typeof candidate.updatedAt === "number"
              ? candidate.updatedAt
              : Date.now(),
          messages,
        };
      })
      .filter((session): session is ChatSession => session !== null)
      .slice(0, MAX_STORED_SESSIONS);

    return sessions.length > 0 ? sessions : [createSession(defaultTitle)];
  } catch {
    return [createSession(defaultTitle)];
  }
}

function isKnowledgeItem(input: unknown): input is KnowledgeItem {
  if (!input || typeof input !== "object") return false;
  const candidate = input as Partial<KnowledgeItem>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.createdAt === "number"
  );
}

function sanitizeKnowledgeItem(item: KnowledgeItem): KnowledgeItem {
  return {
    id: item.id,
    title: item.title.trim().slice(0, 80) || "Untitled",
    content: item.content.slice(0, MAX_KNOWLEDGE_CHARS),
    enabled: item.enabled !== false,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt,
  };
}

function loadStoredKnowledge(): KnowledgeItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ASK_KNOWLEDGE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isKnowledgeItem)
      .map(sanitizeKnowledgeItem)
      .slice(0, MAX_KNOWLEDGE_ITEMS);
  } catch {
    return [];
  }
}

function persistKnowledgeItems(items: KnowledgeItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      ASK_KNOWLEDGE_STORAGE_KEY,
      JSON.stringify(
        items.slice(0, MAX_KNOWLEDGE_ITEMS).map(sanitizeKnowledgeItem),
      ),
    );
  } catch {
    toast.error("知识库保存失败，内容可能过大");
  }
}

function loadLocalPermissions(): LocalDesktopPermissionSettings {
  if (typeof window === "undefined") return DEFAULT_LOCAL_PERMISSIONS;
  try {
    const raw = window.localStorage.getItem(ASK_LOCAL_PERMISSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_LOCAL_PERMISSIONS;
    }
    const candidate = parsed as Partial<LocalDesktopPermissionSettings>;
    const legacy = parsed as Partial<{
      enabled: boolean;
      mode: string;
    }>;
    let mode: LocalDesktopPermissionMode = DEFAULT_LOCAL_PERMISSIONS.mode;
    if (candidate.mode === "basic" || candidate.mode === "confirm") {
      mode = candidate.mode;
    } else if (candidate.mode === "full") {
      mode = "full";
    } else if (legacy.mode === "controlled" || legacy.enabled === true) {
      mode = "confirm";
    }
    return {
      mode,
    };
  } catch {
    return DEFAULT_LOCAL_PERMISSIONS;
  }
}

function persistLocalPermissions(settings: LocalDesktopPermissionSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    ASK_LOCAL_PERMISSIONS_STORAGE_KEY,
    JSON.stringify(settings),
  );
}

let askSessionsCache: ChatSession[] | null = null;
const askSessionListeners = new Set<() => void>();
const askAbortControllers = new Map<string, AbortController>();
let askSendingSessionIds = new Set<string>();
const askSendingListeners = new Set<() => void>();
let visibleAskSessionId: string | null = null;

function persistStoredSessions(sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      ASK_SESSIONS_STORAGE_KEY,
      JSON.stringify(
        sessions.slice(0, MAX_STORED_SESSIONS).map(sanitizeStoredSession),
      ),
    );
  } catch {
    try {
      window.localStorage.setItem(
        ASK_SESSIONS_STORAGE_KEY,
        JSON.stringify(
          sessions.slice(0, MAX_STORED_SESSIONS).map((session) => ({
            ...sanitizeStoredSession(session),
            messages: session.messages.map((message) => ({
              ...sanitizeStoredMessage(message),
              attachments: message.attachments?.map((attachment) => ({
                ...attachment,
                dataUrl: undefined,
              })),
            })),
          })),
        ),
      );
    } catch {
      window.localStorage.removeItem(ASK_SESSIONS_STORAGE_KEY);
    }
  }
}

function getAskSessions(defaultTitle: string): ChatSession[] {
  askSessionsCache ??= loadStoredSessions(defaultTitle);
  return askSessionsCache;
}

function notifyAskSessionListeners() {
  for (const listener of askSessionListeners) {
    listener();
  }
}

function updateAskSessions(
  defaultTitle: string,
  updater: (previous: ChatSession[]) => ChatSession[],
): ChatSession[] {
  const next = updater(getAskSessions(defaultTitle));
  askSessionsCache =
    next.length > 0
      ? next.slice(0, MAX_STORED_SESSIONS)
      : [createSession(defaultTitle)];
  persistStoredSessions(askSessionsCache);
  notifyAskSessionListeners();
  return askSessionsCache;
}

function subscribeAskSessions(listener: () => void): () => void {
  askSessionListeners.add(listener);
  return () => {
    askSessionListeners.delete(listener);
  };
}

function getAskSessionTitle(sessionId: string, defaultTitle: string): string {
  return (
    getAskSessions(defaultTitle).find((session) => session.id === sessionId)
      ?.title ?? defaultTitle
  );
}

function getAskSendingSessionIds(): Set<string> {
  return askSendingSessionIds;
}

function notifyAskSendingListeners() {
  for (const listener of askSendingListeners) {
    listener();
  }
}

function setAskSessionSending(sessionId: string, isSending: boolean) {
  const next = new Set(askSendingSessionIds);
  if (isSending) {
    next.add(sessionId);
  } else {
    next.delete(sessionId);
  }
  askSendingSessionIds = next;
  notifyAskSendingListeners();
}

function subscribeAskSending(listener: () => void): () => void {
  askSendingListeners.add(listener);
  return () => {
    askSendingListeners.delete(listener);
  };
}

function setVisibleAskSessionId(sessionId: string | null) {
  visibleAskSessionId = sessionId;
}

function isAskSessionVisible(sessionId: string): boolean {
  return visibleAskSessionId === sessionId;
}

function getStoredActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ASK_ACTIVE_SESSION_STORAGE_KEY);
}

function formatSessionTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function getApiUrl(path: string): string {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
  const isElectronRenderer =
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Electron");
  const base = isElectronRenderer ? "" : (apiBaseUrl ?? "");
  return `${base.replace(/\/+$/u, "")}${path}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getModelLabel(modelId: string): string {
  return modelId.includes("/")
    ? modelId.split("/").slice(1).join("/")
    : modelId;
}

function getAssistantDisplayName(modelId: string | undefined): string {
  const label = modelId ? getModelLabel(modelId) : "Claw-Pi";
  return `${label} | Claw-Pi`;
}

function getCanonicalModelId(modelId: string | undefined): string {
  if (!modelId) return "";
  return getModelLabel(modelId).toLowerCase();
}

function findChatModelPricing(modelId: string | undefined) {
  const id = getCanonicalModelId(modelId);
  if (!id) return null;
  return (
    CHAT_MODEL_PRICING.find((pricing) =>
      pricing.matchIds.some((candidate) => candidate.toLowerCase() === id),
    ) ?? null
  );
}

function estimateTokenCostYuan(input: {
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
}): number | undefined {
  const pricing = findChatModelPricing(input.modelId);
  if (!pricing) return undefined;
  return (
    (input.inputTokens / 1_000_000) * pricing.inputPerM +
    (input.outputTokens / 1_000_000) * pricing.outputPerM
  );
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(Math.round(count));
}

function formatUsageCost(cost: number | undefined): string | null {
  if (cost === undefined) return null;
  if (cost > 0 && cost < 0.0001) return "<¥0.0001";
  return `¥${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

function formatDurationMs(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function getFileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([^.]+)$/u);
  return match?.[1] ?? "";
}

function getAttachmentKind(file: File): AttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (
    file.type.startsWith("text/") ||
    TEXT_EXTENSIONS.has(getFileExtension(file.name))
  ) {
    return "text";
  }
  return "file";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

async function readAttachment(
  file: File,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<ChatAttachment | null> {
  const kind = getAttachmentKind(file);
  const attachment: ChatAttachment = {
    id: createId("att"),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    kind,
  };

  if (kind === "image") {
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(t("ask.toast.imageTooLarge", { name: file.name }));
      return null;
    }
    return {
      ...attachment,
      dataUrl: await readAsDataUrl(file),
    };
  }

  if (kind === "text") {
    if (file.size > MAX_TEXT_BYTES) {
      toast.error(t("ask.toast.textTooLarge", { name: file.name }));
      return null;
    }
    const [rawText, dataUrl] = await Promise.all([
      file.text(),
      readAsDataUrl(file),
    ]);
    const truncated = rawText.length > MAX_TEXT_CHARS;
    if (truncated) {
      toast.info(t("ask.toast.textTrimmed", { name: file.name }));
    }
    return {
      ...attachment,
      dataUrl,
      text: truncated ? rawText.slice(0, MAX_TEXT_CHARS) : rawText,
      truncated,
    };
  }

  if (file.size > MAX_FILE_BYTES) {
    toast.error(t("ask.toast.fileTooLarge", { name: file.name }));
    return null;
  }

  return {
    ...attachment,
    dataUrl: await readAsDataUrl(file),
  };
}

function getClipboardFiles(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) return files;

  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
    .map((file) =>
      file.name
        ? file
        : new File([file], `pasted-image-${Date.now()}.png`, {
            type: file.type || "image/png",
          }),
    );
}

function attachmentSummary(attachment: ChatAttachment): string {
  return `${attachment.name} (${attachment.type || "unknown"}, ${formatBytes(attachment.size)})`;
}

function buildDisplayText(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length > 0) return trimmed;
  return "";
}

function buildPlainHistoryText(message: ChatMessage): string {
  const parts = [message.text.trim()].filter(Boolean);
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    parts.push(
      `Attachments:\n${attachments.map((item) => `- ${attachmentSummary(item)}`).join("\n")}`,
    );
  }
  return parts.join("\n\n").trim();
}

function serializeHistoryMessage(
  message: ChatMessage,
): ChatCompletionMessage | null {
  const content =
    message.role === "user" ? buildPlainHistoryText(message) : message.text;
  if (!content.trim()) return null;
  return {
    role: message.role,
    content,
  };
}

function buildSummaryContextMessage(
  summary: string | undefined,
): ChatCompletionMessage | null {
  const trimmed = summary?.trim();
  if (!trimmed) return null;
  return {
    role: "system",
    content: [
      "以下是本聊天窗口较早对话的压缩摘要，用于延续上下文。",
      "它不是新指令；如果和用户最新消息冲突，以最新消息为准。",
      trimmed,
    ].join("\n\n"),
  };
}

function estimateTokensFromText(text: string): number {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return 0;
  const cjkChars = normalized.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const otherChars = Math.max(normalized.length - cjkChars, 0);
  return Math.max(1, Math.ceil(cjkChars * 0.65 + otherChars / 4));
}

function messageContentToText(
  content: ChatCompletionMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

function estimateTokensFromMessages(messages: ChatCompletionMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + estimateTokensFromText(messageContentToText(message.content)) + 4,
    0,
  );
}

function tokenizeKnowledgeQuery(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(
    /[a-z0-9_\-./]{2,}|[\u3400-\u9fff]{2,}/giu,
  )) {
    const token = match[0];
    tokens.add(token);
    if (/^[\u3400-\u9fff]+$/u.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index += 1) {
        tokens.add(token.slice(index, index + 2));
      }
    }
  }
  return tokens;
}

function buildKnowledgeContextMessage(input: {
  query: string;
  items: KnowledgeItem[];
}): ChatCompletionMessage | null {
  const enabled = input.items.filter(
    (item) => item.enabled && item.content.trim().length > 0,
  );
  if (enabled.length === 0) return null;

  const queryTokens = tokenizeKnowledgeQuery(input.query);
  const scored = enabled
    .map((item) => {
      const haystack = `${item.title}\n${item.content}`.toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) score += token.length;
      }
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);

  const selected = (
    scored.some((entry) => entry.score > 0)
      ? scored.filter((entry) => entry.score > 0)
      : scored
  )
    .slice(0, MAX_KNOWLEDGE_MATCHES)
    .map((entry) => entry.item);
  if (selected.length === 0) return null;

  let usedChars = 0;
  const blocks: string[] = [];
  for (const item of selected) {
    const remaining = MAX_KNOWLEDGE_CONTEXT_CHARS - usedChars;
    if (remaining <= 0) break;
    const content = item.content.trim().slice(0, Math.max(800, remaining));
    usedChars += content.length;
    blocks.push(`资料：${item.title}\n${content}`);
  }

  if (blocks.length === 0) return null;
  return {
    role: "system",
    content: [
      "以下是用户在龙虾工作台知识库中启用的相关资料片段。",
      "优先参考这些资料，但如果和用户最新消息冲突，以用户最新消息为准。",
      blocks.join("\n\n---\n\n"),
    ].join("\n\n"),
  };
}

function getMessagesAfterSummary(
  messages: ChatMessage[],
  summarizedThroughMessageId?: string,
): ChatMessage[] {
  if (!summarizedThroughMessageId) return messages;
  const index = messages.findIndex(
    (message) => message.id === summarizedThroughMessageId,
  );
  return index >= 0 ? messages.slice(index + 1) : messages;
}

function formatMessagesForCompaction(messages: ChatMessage[]): string {
  const blocks = messages.map((message) => {
    const label = message.role === "user" ? "用户" : "助手";
    const text =
      message.role === "user" ? buildPlainHistoryText(message) : message.text;
    return `${label}：\n${text.trim() || "[空消息]"}`;
  });
  const source = blocks.join("\n\n---\n\n");
  if (source.length <= MAX_COMPACTION_SOURCE_CHARS) return source;
  return source.slice(source.length - MAX_COMPACTION_SOURCE_CHARS);
}

function getCompactionPlan(input: {
  messages: ChatMessage[];
  summarizedThroughMessageId?: string;
}): {
  messagesToCompact: ChatMessage[];
  summarizedThroughMessageId: string;
} | null {
  const unsummarizedMessages = getMessagesAfterSummary(
    input.messages,
    input.summarizedThroughMessageId,
  ).filter((message) => !message.streaming);
  if (unsummarizedMessages.length <= COMPACTION_TRIGGER_MESSAGES) return null;

  const messagesToCompact = unsummarizedMessages.slice(
    0,
    -COMPACTION_KEEP_RECENT_MESSAGES,
  );
  const summarizedThroughMessageId =
    messagesToCompact[messagesToCompact.length - 1]?.id;
  if (!summarizedThroughMessageId || messagesToCompact.length < 4) return null;
  return { messagesToCompact, summarizedThroughMessageId };
}

function buildCurrentUserPayload(input: {
  text: string;
  attachments: ChatAttachment[];
}): ChatCompletionMessage {
  const textParts = [input.text.trim()].filter(Boolean);
  for (const attachment of input.attachments) {
    if (attachment.kind === "text" && attachment.text) {
      textParts.push(
        [
          `File: ${attachment.name}`,
          "```",
          attachment.text,
          "```",
          attachment.truncated ? "[content truncated]" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      continue;
    }

    if (attachment.kind === "video" || attachment.kind === "file") {
      textParts.push(`Attached file: ${attachmentSummary(attachment)}`);
    }
  }

  const text = textParts.join("\n\n").trim();
  const imageAttachments = input.attachments.filter(
    (attachment) => attachment.kind === "image" && attachment.dataUrl,
  );

  if (imageAttachments.length === 0) {
    return {
      role: "user",
      content: text,
    };
  }

  return {
    role: "user",
    content: [
      { type: "text", text },
      ...imageAttachments.map((attachment) => ({
        type: "image_url" as const,
        image_url: {
          url: attachment.dataUrl ?? "",
          detail: "auto" as const,
        },
      })),
    ],
  };
}

function extractChatContentText(
  content: ChatCompletionMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function isInsufficientBalanceError(message: string): boolean {
  return /(?:token quota is not enough|need quota|insufficient (?:balance|quota|credits?)|quota.+not enough|余额不足|额度不足|余额不够|充值)/iu.test(
    message,
  );
}

function normalizeWorkbenchErrorMessage(message: string): string {
  return isInsufficientBalanceError(message)
    ? INSUFFICIENT_BALANCE_MESSAGE
    : message;
}

function getMessageContentForIntent(message: ChatMessage): string {
  const attachmentText = (message.attachments ?? [])
    .map(
      (attachment) =>
        `${attachment.name} ${attachment.type} ${attachment.kind}`,
    )
    .join(" ");
  return `${message.text} ${attachmentText}`.trim();
}

function buildRecentHistoryContext(messages: ChatMessage[]): string {
  const blocks = messages
    .filter((message) => !message.streaming)
    .slice(-AGENT_HISTORY_CONTEXT_MESSAGES)
    .map((message) => {
      const label = message.role === "user" ? "用户" : "助手";
      const text =
        message.role === "user" ? buildPlainHistoryText(message) : message.text;
      return `${label}：${text.trim()}`;
    })
    .filter((block) => !/：\s*$/u.test(block));
  const context = blocks.join("\n\n");
  if (context.length <= AGENT_HISTORY_CONTEXT_CHARS) return context;
  return context.slice(context.length - AGENT_HISTORY_CONTEXT_CHARS);
}

function isContinuationText(text: string): boolean {
  return /^(?:继续|接着|继续处理|继续执行|好的继续|然后呢|然后|是的|好的|ok|嗯|行)$/iu.test(
    text.trim(),
  );
}

function hasRecentAgentTaskContext(messages: ChatMessage[]): boolean {
  const recent = messages
    .slice(-AGENT_HISTORY_CONTEXT_MESSAGES)
    .map(getMessageContentForIntent)
    .join("\n");
  return /(?:桌面|onedrive|本机|电脑|文件|目录|路径|pdf|excel|word|ppt|简历|安装包|应用|网页|浏览器|截图|图片|生图|改图|图生图|读取|查找|搜索|定位|提取|总结|分析|运行|执行|重启|安装|下载|生成|处理|修复|验证|测试)/iu.test(
    recent,
  );
}

function hasRecentImageGenerationContext(messages: ChatMessage[]): boolean {
  const recent = messages
    .slice(-AGENT_HISTORY_CONTEXT_MESSAGES)
    .map(getMessageContentForIntent)
    .join("\n");
  return /(?:生图|生成图片|画一张|画个|改图|修图|图生图|换背景|生成.*海报|image_generate|generate (?:an? )?image|create (?:an? )?image|edit (?:the )?image)/iu.test(
    recent,
  );
}

function classifyWorkbenchRequest(input: {
  text: string;
  attachments: ChatAttachment[];
  permissionMode: LocalDesktopPermissionMode;
  recentMessages: ChatMessage[];
}): WorkbenchRequestRoute {
  const normalized = input.text.replace(/\s+/gu, " ").trim();
  const attachmentSummary = input.attachments
    .map(
      (attachment) =>
        `${attachment.name} ${attachment.type} ${attachment.kind}`,
    )
    .join(" ");
  const haystack = `${normalized} ${attachmentSummary}`;
  const hasAttachment = input.attachments.length > 0;
  const hasImageAttachment = input.attachments.some(
    (attachment) => attachment.kind === "image",
  );

  const imageGenerationRequest =
    /(?:生图|生成图片|画一张|画个|改图|修图|图生图|换背景|生成.*海报|generate (?:an? )?image|create (?:an? )?image|edit (?:the )?image)/iu.test(
      haystack,
    );
  if (
    imageGenerationRequest ||
    (hasImageAttachment &&
      hasRecentImageGenerationContext(input.recentMessages))
  ) {
    return "image_generation";
  }

  const writeRequest =
    /(?:创建|新建|写入|保存|另存|导出|生成(?:一个|一份|成)?(?:文件|文档|docx|excel|表格|ppt|pdf)|修改|编辑|删除|移动|复制|重命名|运行|执行|重启|安装|下载|打包|发布|提交|替换|覆盖|添加|新增|插入|追加|补充|填入|录入|登记|更新|改成|加(?:上|入|到|一行|一列|一条))/iu.test(
      haystack,
    ) ||
    /\b(?:create|write|save|export|modify|edit|delete|move|copy|rename|run|execute|restart|install|download|package|publish|add|insert|append|update)\b/iu.test(
      haystack,
    );
  if (writeRequest) {
    return "write_agent";
  }

  const explicitLocalContext =
    /(?:桌面|onedrive|本机|电脑|本地|下载目录|文档目录|文件夹|目录|路径|浏览器|网页|应用|程序|安装包|desktop|downloads?|documents?|folder|path|browser|app|installer)/iu.test(
      normalized,
    );
  if (hasAttachment && !explicitLocalContext) {
    return "chat";
  }

  const readOnlyRequest =
    /(?:桌面|onedrive|本机|电脑|文件|目录|路径|pdf|excel|word|ppt|简历|安装包|网页|浏览器|截图)/iu.test(
      haystack,
    ) ||
    /(?:查找|搜索|定位|读取|打开看看|提取|总结|分析|查看)(?:[^。！？.!?\n]{0,50})(?:文件|目录|路径|桌面|电脑|本机|网页|简历|pdf|excel|word|ppt)/iu.test(
      haystack,
    ) ||
    /\b(?:find|search|locate|read|extract|summarize|analyze|inspect)\b(?:[^.!?\n]{0,60})\b(?:file|folder|path|desktop|computer|pdf|excel|word|ppt|resume|webpage)\b/iu.test(
      haystack,
    );
  if (readOnlyRequest) {
    return "read_only_agent";
  }

  if (
    isContinuationText(normalized) &&
    hasRecentAgentTaskContext(input.recentMessages)
  ) {
    return "read_only_agent";
  }

  return "chat";
}

function buildAgentWorkbenchMessage(input: {
  text: string;
  attachments: ChatAttachment[];
  summaryMessage: ChatCompletionMessage | null;
  knowledgeMessage: ChatCompletionMessage | null;
  recentHistoryContext: string;
}): string {
  const contextBlocks = [
    input.summaryMessage
      ? `历史摘要：\n${extractChatContentText(input.summaryMessage.content)}`
      : "",
    input.knowledgeMessage
      ? `知识库资料：\n${extractChatContentText(input.knowledgeMessage.content)}`
      : "",
    input.recentHistoryContext
      ? `最近对话：\n${input.recentHistoryContext}`
      : "",
  ].filter(Boolean);
  const currentUserText = extractChatContentText(
    buildCurrentUserPayload({
      text: input.text,
      attachments: input.attachments,
    }).content,
  );
  const attachmentOnlyPrompt =
    currentUserText || input.attachments.length === 0
      ? ""
      : [
          "用户刚上传了附件但没有输入文字说明。请结合最近对话判断用户意图，然后直接替用户完成对应任务。",
          "如果最近上下文无法判断具体需求，请简要说明你已经看到附件，并询问用户希望如何处理；不要把本段内部说明复述成用户原文。",
          `附件：${input.attachments.map(attachmentSummary).join("；")}`,
        ].join("\n");

  if (contextBlocks.length === 0) {
    return currentUserText || attachmentOnlyPrompt || input.text;
  }

  return [
    "以下是龙虾工作台传入的上下文，只用于理解当前问题；真正要回答的是最后的用户当前消息。",
    contextBlocks.join("\n\n---\n\n"),
    `用户当前消息：\n${currentUserText || attachmentOnlyPrompt || input.text}`,
  ].join("\n\n");
}

function limitAgentWorkbenchMessage(input: {
  message: string;
  contextBlocks: string[];
  currentBlock: string;
}): string {
  const message = input.message;
  if (message.length <= MAX_AGENT_WORKBENCH_CHARS) return message;
  const currentBlock = input.currentBlock;
  if (currentBlock.length >= MAX_AGENT_WORKBENCH_CHARS) {
    const truncationMarker = "\n...[current task truncated]...\n";
    const available = Math.max(
      1,
      MAX_AGENT_WORKBENCH_CHARS - truncationMarker.length,
    );
    const headLength = Math.floor(MAX_AGENT_WORKBENCH_CHARS * 0.8);
    const boundedHeadLength = Math.min(headLength, available);
    const tailLength = available - boundedHeadLength;
    return `${currentBlock.slice(0, boundedHeadLength)}${truncationMarker}${currentBlock.slice(-tailLength)}`;
  }

  let remaining = MAX_AGENT_WORKBENCH_CHARS - currentBlock.length;
  const selectedContext: string[] = [];

  for (const block of input.contextBlocks) {
    if (!block.trim() || remaining <= 0) break;
    const separatorLength = selectedContext.length > 0 ? 2 : 0;
    const available = remaining - separatorLength;
    if (available <= 0) break;
    const bounded = block.slice(0, available);
    if (!bounded.trim()) continue;
    selectedContext.push(bounded);
    remaining -= separatorLength + bounded.length;
  }

  return [...selectedContext, currentBlock].filter(Boolean).join("\n\n");
}

async function readStreamedCompletion(
  response: Response,
  onDelta: (delta: string) => void,
): Promise<StreamedCompletionResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: await response.text() };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let errorMessage: string | undefined;
  let finishReason: string | null | undefined;
  let usage: StreamedCompletionResult["usage"];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
          error?: { message?: string } | string;
        };
        if (parsed.error) {
          errorMessage =
            typeof parsed.error === "string"
              ? parsed.error
              : parsed.error.message || "Agent stream failed";
        }
        finishReason =
          parsed.choices?.[0]?.finish_reason ?? finishReason ?? null;
        if (parsed.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
          };
        }
        const delta =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          "";
        if (!delta) continue;
        assistantText += delta;
        onDelta(delta);
      } catch {
        // Some compatible providers send heartbeat/comment lines; ignore them.
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing.startsWith("data:")) {
    const data = trailing.slice(5).trim();
    if (data && data !== "[DONE]") {
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
          error?: { message?: string } | string;
        };
        if (parsed.error) {
          errorMessage =
            typeof parsed.error === "string"
              ? parsed.error
              : parsed.error.message || "Agent stream failed";
        }
        finishReason =
          parsed.choices?.[0]?.finish_reason ?? finishReason ?? null;
        if (parsed.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
          };
        }
        const delta =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          "";
        if (delta) {
          assistantText += delta;
          onDelta(delta);
        }
      } catch {
        // Ignore malformed trailing chunks.
      }
    }
  }

  return {
    text: assistantText,
    error: errorMessage,
    finishReason,
    usage,
  };
}

async function fetchAgentChatStream(input: {
  requestId: string;
  sessionId: string;
  modelId: string;
  message: string;
  attachments: ChatAttachment[];
  permissionMode: LocalDesktopPermissionMode;
  executionMode: AgentExecutionMode;
  signal: AbortSignal;
}): Promise<Response> {
  const response = await fetch(getApiUrl("/api/internal/agent-chat/stream"), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: input.requestId,
      sessionId: input.sessionId,
      modelId: input.modelId || undefined,
      message: input.message,
      permissionMode: input.permissionMode,
      executionMode: input.executionMode,
      attachments: input.attachments.map((attachment) => ({
        name: attachment.name,
        type: attachment.type,
        kind: attachment.kind,
        size: attachment.size,
        dataUrl: attachment.dataUrl,
      })),
    }),
    signal: input.signal,
  });

  if (response.ok) return response;
  throw new Error(
    normalizeWorkbenchErrorMessage(
      (await response.text()) || "OpenClaw agent chat failed",
    ),
  );
}

async function compactSessionContext(input: {
  modelId: string;
  existingSummary?: string;
  messagesToCompact: ChatMessage[];
  signal?: AbortSignal;
}): Promise<string> {
  const compactSource = formatMessagesForCompaction(input.messagesToCompact);
  const response = await fetch(getApiUrl("/v1/chat/completions"), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.modelId,
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "你是对话上下文压缩器。把旧对话合并成后续问答可用的摘要，不添加新信息，不回答用户问题。",
        },
        {
          role: "user",
          content: [
            "请把以下内容压缩成一段稳定上下文摘要。",
            "必须保留：用户偏好、重要事实、任务目标、已做决定、未完成事项、文件/图片相关信息。",
            "可以删除：寒暄、重复确认、无意义短句。",
            "摘要控制在 1200 字以内，用中文。",
            input.existingSummary
              ? `已有摘要，请合并更新：\n${input.existingSummary}`
              : "",
            `待压缩旧对话：\n${compactSource}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    }),
    signal: input.signal,
  });

  if (!response.ok) {
    throw new Error((await response.text()) || "Context compaction failed");
  }

  return (await readStreamedCompletion(response, () => {})).text
    .trim()
    .slice(0, MAX_CONTEXT_SUMMARY_CHARS);
}

const generatedImageMarkdownPattern =
  /!\[[^\]]*\]\((https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif))\)|(^|[\s>])(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif))(?=$|[\s<])/giu;

function getGeneratedImageUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(generatedImageMarkdownPattern)) {
    const url = match[1] || match[3];
    if (url) urls.add(url);
  }
  return [...urls];
}

async function copyTextToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function AttachmentIcon({ kind }: { kind: AttachmentKind }) {
  if (kind === "image") return <ImageIcon size={13} />;
  if (kind === "video") return <Video size={13} />;
  return <FileText size={13} />;
}

function MessageBubble({
  message,
  assistantLabel,
  onPreviewImage,
}: {
  message: ChatMessage;
  assistantLabel: string;
  onPreviewImage: (image: PreviewImage) => void;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const attachments = message.attachments ?? [];
  const generatedImageUrls = getGeneratedImageUrls(message.text);
  const durationLabel = formatDurationMs(message.durationMs);

  const handleCopyText = async () => {
    try {
      await copyTextToClipboard(message.text);
      toast.success(t("ask.toast.copied"));
    } catch {
      toast.error(t("ask.toast.copyFailed"));
    }
  };

  const handleCopyImage = async (src: string) => {
    try {
      const result = await copyImageToClipboard(src);
      toast.success(
        result === "image"
          ? t("ask.toast.imageCopied")
          : t("ask.toast.linkCopied"),
      );
    } catch {
      toast.error(t("ask.toast.copyFailed"));
    }
  };

  const handleDownloadImage = async (src: string, name: string) => {
    try {
      await downloadImage(src, name);
      toast.success(t("ask.toast.imageDownloaded"));
    } catch {
      toast.error(t("ask.toast.downloadFailed"));
    }
  };

  return (
    <div className="group flex gap-3 py-3">
      {isUser ? (
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-white shadow-sm">
          <UserRound size={17} />
        </div>
      ) : (
        <img
          src="/brand/ip-claw-pi.svg"
          alt=""
          className="mt-0.5 h-8 w-8 shrink-0 rounded-lg object-cover shadow-sm"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-w-0 items-baseline gap-2">
          <div className="truncate text-[13px] font-semibold text-text-primary">
            {isUser ? t("ask.you") : (message.modelLabel ?? assistantLabel)}
          </div>
          <div className="shrink-0 text-[10px] tabular-nums text-text-muted">
            {formatSessionTime(message.createdAt)}
          </div>
        </div>
        {attachments.length > 0 && (
          <div className="mb-2 grid max-w-2xl grid-cols-1 gap-1.5 sm:grid-cols-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="min-w-0 rounded-md border border-border/70 bg-transparent px-2 py-1.5 text-text-secondary"
              >
                {attachment.kind === "image" && attachment.dataUrl ? (
                  <button
                    type="button"
                    onClick={() =>
                      onPreviewImage({
                        src: attachment.dataUrl ?? "",
                        name: attachment.name,
                      })
                    }
                    className="group relative mb-1.5 block w-full overflow-hidden rounded-md text-left"
                  >
                    <img
                      alt={attachment.name}
                      src={attachment.dataUrl}
                      className="max-h-48 w-full object-contain transition-transform group-hover:scale-[1.01]"
                    />
                    <span className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <Maximize2 size={13} />
                    </span>
                  </button>
                ) : null}
                <div className="flex min-w-0 items-center gap-1.5">
                  <AttachmentIcon kind={attachment.kind} />
                  <span className="truncate text-[11px] font-medium">
                    {attachment.name}
                  </span>
                </div>
                <div
                  className={cn(
                    "mt-0.5 text-[10px]",
                    isUser ? "text-text-muted" : "text-text-muted",
                  )}
                >
                  {formatBytes(attachment.size)}
                </div>
                {attachment.kind === "image" && attachment.dataUrl ? (
                  <div className="mt-1.5 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        onPreviewImage({
                          src: attachment.dataUrl ?? "",
                          name: attachment.name,
                        })
                      }
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                      aria-label={t("ask.zoomImage")}
                      title={t("ask.zoomImage")}
                    >
                      <Maximize2 size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopyImage(attachment.dataUrl ?? "")
                      }
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                      aria-label={t("ask.copyImage")}
                      title={t("ask.copyImage")}
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleDownloadImage(
                          attachment.dataUrl ?? "",
                          attachment.name,
                        )
                      }
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                      aria-label={t("ask.downloadImage")}
                      title={t("ask.downloadImage")}
                    >
                      <Download size={12} />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {message.text.trim().length > 0 ? (
          <div className="max-w-[780px] text-[14px] leading-7 text-text-primary">
            <ChatMarkdown
              content={message.text}
              onImageClick={(src, alt) =>
                onPreviewImage({ src, name: alt || "image.png" })
              }
            />
          </div>
        ) : message.streaming ? (
          <div className="inline-flex items-center gap-1.5 text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            {t("ask.thinking")}
          </div>
        ) : null}
        {generatedImageUrls.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {generatedImageUrls.map((url, index) => {
              const name = `generated-${index + 1}.png`;
              return (
                <div key={url} className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onPreviewImage({ src: url, name })}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                    aria-label={t("ask.zoomImage")}
                    title={t("ask.zoomImage")}
                  >
                    <Maximize2 size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopyImage(url)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                    aria-label={t("ask.copyImage")}
                    title={t("ask.copyImage")}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDownloadImage(url, name)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                    aria-label={t("ask.downloadImage")}
                    title={t("ask.downloadImage")}
                  >
                    <Download size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="mt-2 flex max-w-[780px] items-center justify-between gap-2 text-[10px] text-text-muted">
          <div className="flex items-center gap-1">
            {message.text.trim().length > 0 ? (
              <button
                type="button"
                onClick={() => void handleCopyText()}
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                <Copy size={11} />
                {t("ask.copyMessage")}
              </button>
            ) : null}
          </div>
          {message.usage ? (
            <div className="shrink-0 text-right tabular-nums">
              <span>
                {message.usage.estimated ? t("ask.usage.estimated") : ""}
                {t("ask.usage.tokens")}:{" "}
                {formatTokenCount(message.usage.totalTokens)} ↑
                {formatTokenCount(message.usage.inputTokens)} ↓
                {formatTokenCount(message.usage.outputTokens)}
              </span>
              {formatUsageCost(message.usage.costYuan) ? (
                <span className="ml-2">
                  {t("ask.usage.cost")}{" "}
                  {formatUsageCost(message.usage.costYuan)}
                </span>
              ) : null}
              {durationLabel ? (
                <span className="ml-2">
                  {t("ask.usage.duration")} {durationLabel}
                </span>
              ) : null}
            </div>
          ) : durationLabel ? (
            <div className="shrink-0 text-right tabular-nums">
              {t("ask.usage.duration")} {durationLabel}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AskPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const knowledgeFileInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const compactingSessionPromisesRef = useRef<Map<string, Promise<void>>>(
    new Map(),
  );
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [knowledgeItems, setKnowledgeItems] =
    useState<KnowledgeItem[]>(loadStoredKnowledge);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeContent, setKnowledgeContent] = useState("");
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);

  const handlePreviewCopyImage = useCallback(async () => {
    if (!previewImage) return;
    try {
      const result = await copyImageToClipboard(previewImage.src);
      toast.success(
        result === "image"
          ? t("ask.toast.imageCopied")
          : t("ask.toast.linkCopied"),
      );
    } catch {
      toast.error(t("ask.toast.copyFailed"));
    }
  }, [previewImage, t]);

  const handlePreviewDownloadImage = useCallback(async () => {
    if (!previewImage) return;
    try {
      await downloadImage(previewImage.src, previewImage.name);
      toast.success(t("ask.toast.imageDownloaded"));
    } catch {
      toast.error(t("ask.toast.downloadFailed"));
    }
  }, [previewImage, t]);
  const [sessions, setSessionsState] = useState<ChatSession[]>(() =>
    getAskSessions(t("ask.newChat")),
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const storedId = getStoredActiveSessionId();
    const initialSessions = getAskSessions(t("ask.newChat"));
    return (
      (storedId && initialSessions.some((session) => session.id === storedId)
        ? storedId
        : null) ??
      initialSessions[0]?.id ??
      createSession(t("ask.newChat")).id
    );
  });
  const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(
    () => new Set(getAskSendingSessionIds()),
  );
  const [askActivity, setAskActivity] = useState(readAskActivity);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");
  const [confirmAction, setConfirmAction] = useState<
    "clearContext" | "clearChat" | null
  >(null);
  const [localPermissions, setLocalPermissions] =
    useState<LocalDesktopPermissionSettings>(loadLocalPermissions);
  const [localPermissionsOpen, setLocalPermissionsOpen] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);

  const { data: configSyncStatus } = useQuery({
    queryKey: ["desktop-config-sync-status"],
    queryFn: async () => {
      const response = await fetch(getApiUrl("/api/internal/desktop/ready"), {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        configSync?: {
          state?: string;
          activeAgentStreams?: number;
          pendingRevision?: string | null;
        };
      };
      return payload.configSync ?? null;
    },
    refetchInterval: 2_000,
  });
  const isConfigRestartDeferred =
    configSyncStatus?.state === "RESTART_PENDING" &&
    Boolean(configSyncStatus.pendingRevision) &&
    (configSyncStatus.activeAgentStreams ?? 0) > 0;

  const { data: defaultModelData } = useQuery({
    queryKey: ["desktop-default-model"],
    queryFn: async () => {
      const { data } = await getApiInternalDesktopDefaultModel();
      return data as { modelId: string | null } | undefined;
    },
    refetchInterval: 5_000,
  });

  const { data: runtimeStatus } = useQuery({
    queryKey: ["sidebar-runtime-status"],
    queryFn: async () => {
      const { data } = await getApiInternalDesktopReady();
      return data;
    },
    refetchInterval: 3_000,
  });
  const { isFullyOnline: isRuntimeReady, showBootGrace: showRuntimeBootGrace } =
    useBootGrace(runtimeStatus);

  const { data: modelsData } = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const { data } = await getApiV1Models();
      return data;
    },
    refetchInterval: 10_000,
  });

  const models = useMemo(
    () => withDisplayAliasModels((modelsData?.models ?? []) as Model[]),
    [modelsData],
  );
  const currentModelId = resolveDisplayModelId(defaultModelData?.modelId ?? "");
  // Re-render when the display-alias choice changes elsewhere (龙虾窝 / 模型广场)
  // so the shown model name stays consistent.
  const [, forceModelRerender] = useState(0);
  useEffect(
    () => subscribeModelDisplayChoice(() => forceModelRerender((n) => n + 1)),
    [],
  );
  const assistantLabel = getAssistantDisplayName(currentModelId);
  const pickerModels = useMemo(() => {
    if (
      !currentModelId ||
      models.some((model) => model.id === currentModelId)
    ) {
      return models;
    }
    return [
      {
        id: currentModelId,
        name: getModelLabel(currentModelId),
        provider: currentModelId.split("/")[0] ?? "nexu",
      },
      ...models,
    ];
  }, [currentModelId, models]);

  const updateModel = useMutation({
    mutationFn: async (modelId: string) => {
      const backendModelId = resolveBackendModelId(modelId);
      const toastId = toast.loading(t("models.switchingModel"));
      const { data, error } = await putApiInternalDesktopDefaultModel({
        body: { modelId: backendModelId },
      });
      if (error) {
        const message =
          typeof error === "object" &&
          error !== null &&
          "error" in error &&
          typeof error.error === "string"
            ? error.error
            : t("models.modelSwitchFailed");
        toast.error(message, { id: toastId });
        throw new Error(message);
      }
      if (data?.ok === false) {
        const message = data.error ?? t("models.modelSwitchFailed");
        toast.error(message, { id: toastId });
        throw new Error(message);
      }
      return { toastId };
    },
    onSuccess: async ({ toastId }) => {
      await queryClient.refetchQueries({ queryKey: ["desktop-default-model"] });
      queryClient.invalidateQueries({ queryKey: ["models"] });
      queryClient.invalidateQueries({ queryKey: ["channels-live-status"] });
      toast.success(t("models.modelSwitched"), { id: toastId });
    },
  });
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const activeSessionIsSending = activeSession?.id
    ? sendingSessionIds.has(activeSession.id)
    : false;
  const controlsDisabled =
    !isRuntimeReady || activeSessionIsSending || updateModel.isPending;
  const runtimeNotice = isRuntimeReady
    ? null
    : showRuntimeBootGrace || runtimeStatus?.status === "starting"
      ? t("ask.runtimeStarting")
      : t("ask.runtimeNotReady");
  const messages = activeSession?.messages ?? [];
  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const contextMenuSession = contextMenu
    ? sessions.find((session) => session.id === contextMenu.sessionId)
    : null;
  const unreadSessionIds = useMemo(
    () => new Set(askActivity.unreadSessionIds),
    [askActivity.unreadSessionIds],
  );

  const updateSessions = useCallback(
    (updater: (previous: ChatSession[]) => ChatSession[]) => {
      updateAskSessions(t("ask.newChat"), updater);
    },
    [t],
  );

  useEffect(() => {
    const syncSessions = () => {
      setSessionsState([...getAskSessions(t("ask.newChat"))]);
    };
    syncSessions();
    return subscribeAskSessions(syncSessions);
  }, [t]);

  useEffect(() => {
    const syncSending = () => {
      setSendingSessionIds(new Set(getAskSendingSessionIds()));
    };
    syncSending();
    return subscribeAskSending(syncSending);
  }, []);

  useEffect(() => subscribeAskActivity(setAskActivity), []);

  useEffect(() => {
    persistKnowledgeItems(knowledgeItems);
  }, [knowledgeItems]);

  useEffect(() => {
    persistLocalPermissions(localPermissions);
  }, [localPermissions]);

  useEffect(() => {
    setVisibleAskSessionId(activeSessionId || null);
    if (activeSessionId) {
      clearAskUnread(activeSessionId);
    }
    return () => {
      if (visibleAskSessionId === activeSessionId) {
        setVisibleAskSessionId(null);
      }
    };
  }, [activeSessionId]);

  const updateSessionMessages = useCallback(
    (
      sessionId: string,
      updater: (
        messages: ChatMessage[],
        session: ChatSession,
      ) => {
        messages: ChatMessage[];
        title?: string;
        titleSource?: "auto" | "manual";
        contextSummary?: string | null;
        summarizedThroughMessageId?: string | null;
        summaryUpdatedAt?: number | null;
      },
    ) => {
      updateSessions((previous) =>
        previous.map((session) => {
          if (session.id !== sessionId) return session;
          const next = updater(session.messages, session);
          return {
            ...session,
            title: next.title ?? session.title,
            titleSource: next.titleSource ?? session.titleSource,
            contextSummary:
              next.contextSummary === undefined
                ? session.contextSummary
                : (next.contextSummary ?? undefined),
            summarizedThroughMessageId:
              next.summarizedThroughMessageId === undefined
                ? session.summarizedThroughMessageId
                : (next.summarizedThroughMessageId ?? undefined),
            summaryUpdatedAt:
              next.summaryUpdatedAt === undefined
                ? session.summaryUpdatedAt
                : (next.summaryUpdatedAt ?? undefined),
            messages: next.messages,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [updateSessions],
  );

  const setSessionSending = useCallback(
    (sessionId: string, isSending: boolean) => {
      setAskSessionSending(sessionId, isSending);
    },
    [],
  );

  const compactSessionIfNeeded = useCallback(
    async (input: {
      sessionId: string;
      modelId: string;
      messages: ChatMessage[];
      contextSummary?: string;
      summarizedThroughMessageId?: string;
    }) => {
      if (!input.modelId) {
        return;
      }

      const existingPromise = compactingSessionPromisesRef.current.get(
        input.sessionId,
      );
      if (existingPromise) {
        await existingPromise;
        return;
      }

      const plan = getCompactionPlan({
        messages: input.messages,
        summarizedThroughMessageId: input.summarizedThroughMessageId,
      });
      if (!plan) return;

      const compactionPromise = (async () => {
        try {
          const summary = await compactSessionContext({
            modelId: input.modelId,
            existingSummary: input.contextSummary,
            messagesToCompact: plan.messagesToCompact,
          });
          if (!summary) return;

          updateSessions((previous) =>
            previous.map((session) => {
              if (session.id !== input.sessionId) return session;
              const nextIndex = session.messages.findIndex(
                (message) => message.id === plan.summarizedThroughMessageId,
              );
              const currentIndex = session.summarizedThroughMessageId
                ? session.messages.findIndex(
                    (message) =>
                      message.id === session.summarizedThroughMessageId,
                  )
                : -1;
              if (nextIndex < currentIndex) return session;
              return {
                ...session,
                contextSummary: summary,
                summarizedThroughMessageId: plan.summarizedThroughMessageId,
                summaryUpdatedAt: Date.now(),
              };
            }),
          );
        } catch (error) {
          console.warn(
            "Ask context compaction failed",
            error instanceof Error ? error.message : error,
          );
        }
      })();
      compactingSessionPromisesRef.current.set(
        input.sessionId,
        compactionPromise,
      );
      try {
        await compactionPromise;
      } finally {
        if (
          compactingSessionPromisesRef.current.get(input.sessionId) ===
          compactionPromise
        ) {
          compactingSessionPromisesRef.current.delete(input.sessionId);
        }
      }
    },
    [updateSessions],
  );

  const renameSession = useCallback(
    (sessionId: string, title: string) => {
      const nextTitle = title.trim().slice(0, 64);
      if (!nextTitle) return;
      updateSessions((previous) =>
        previous.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                title: nextTitle,
                titleSource: "manual",
                updatedAt: Date.now(),
              }
            : session,
        ),
      );
    },
    [updateSessions],
  );

  const startRenamingSession = useCallback((session: ChatSession) => {
    setRenamingSessionId(session.id);
    setRenameValue(session.title);
    setContextMenu(null);
  }, []);

  const finishRenamingSession = useCallback(() => {
    if (!renamingSessionId) return;
    renameSession(renamingSessionId, renameValue);
    setRenamingSessionId(null);
    setRenameValue("");
  }, [renameSession, renameValue, renamingSessionId]);

  const handleRenameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    finishRenamingSession();
  };

  const openSessionMenu = useCallback(
    (event: MouseEvent<HTMLElement>, sessionId: string) => {
      event.preventDefault();
      setActiveSessionId(sessionId);
      setContextMenu({
        sessionId,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [],
  );

  const createNewSession = useCallback(() => {
    const session = createSession(t("ask.newChat"));
    updateSessions((previous) =>
      [session, ...previous].slice(0, MAX_STORED_SESSIONS),
    );
    setActiveSessionId(session.id);
    setInput("");
    setAttachments([]);
  }, [t, updateSessions]);

  const deleteSession = useCallback(
    (sessionId: string) => {
      askAbortControllers.get(sessionId)?.abort();
      askAbortControllers.delete(sessionId);
      setSessionSending(sessionId, false);
      clearAskUnread(sessionId);
      setContextMenu(null);
      if (renamingSessionId === sessionId) {
        setRenamingSessionId(null);
        setRenameValue("");
      }
      updateSessions((previous) => {
        const next = previous.filter((session) => session.id !== sessionId);
        if (next.length === 0) {
          const session = createSession(t("ask.newChat"));
          setActiveSessionId(session.id);
          return [session];
        }
        if (sessionId === activeSessionId) {
          setActiveSessionId(next[0]?.id ?? "");
        }
        return next;
      });
    },
    [activeSessionId, renamingSessionId, setSessionSending, t, updateSessions],
  );

  const saveKnowledgeItem = useCallback(() => {
    const content = knowledgeContent.trim();
    if (!content) {
      toast.info(t("ask.toast.knowledgeEmpty"));
      return;
    }
    const now = Date.now();
    const title =
      knowledgeTitle.trim() ||
      content
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0)
        ?.trim()
        .slice(0, 42) ||
      t("ask.knowledgeUntitled");
    const item: KnowledgeItem = {
      id: createId("kb"),
      title,
      content: content.slice(0, MAX_KNOWLEDGE_CHARS),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    setKnowledgeItems((previous) =>
      [item, ...previous].slice(0, MAX_KNOWLEDGE_ITEMS),
    );
    setKnowledgeTitle("");
    setKnowledgeContent("");
    toast.success(t("ask.toast.knowledgeSaved"));
  }, [knowledgeContent, knowledgeTitle, t]);

  const addKnowledgeFiles = useCallback(
    async (files: FileList | File[]) => {
      const now = Date.now();
      const next: KnowledgeItem[] = [];
      for (const file of Array.from(files)) {
        const kind = getAttachmentKind(file);
        if (kind !== "text") {
          toast.info(t("ask.toast.knowledgeTextOnly", { name: file.name }));
          continue;
        }
        try {
          const rawText = await file.text();
          if (!rawText.trim()) continue;
          next.push({
            id: createId("kb"),
            title: file.name,
            content: rawText.trim().slice(0, MAX_KNOWLEDGE_CHARS),
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
        } catch {
          toast.error(t("ask.toast.readFailed", { name: file.name }));
        }
      }
      if (next.length > 0) {
        setKnowledgeItems((previous) =>
          [...next, ...previous].slice(0, MAX_KNOWLEDGE_ITEMS),
        );
        toast.success(t("ask.toast.knowledgeImported", { count: next.length }));
      }
    },
    [t],
  );

  const clearCurrentContext = useCallback(() => {
    if (!activeSession?.id) return;
    const lastMessageId =
      activeSession.messages[activeSession.messages.length - 1]?.id ?? null;
    updateSessionMessages(activeSession.id, (previous) => ({
      messages: previous,
      contextSummary: null,
      summarizedThroughMessageId: lastMessageId,
      summaryUpdatedAt: Date.now(),
    }));
    toast.success(t("ask.toast.contextCleared"));
  }, [activeSession, t, updateSessionMessages]);

  const clearCurrentChat = useCallback(() => {
    if (!activeSession?.id) return;
    updateSessionMessages(activeSession.id, () => ({
      messages: [],
      title: t("ask.newChat"),
      titleSource: "auto",
      contextSummary: null,
      summarizedThroughMessageId: null,
      summaryUpdatedAt: null,
    }));
    setInput("");
    setAttachments([]);
  }, [activeSession?.id, t, updateSessionMessages]);

  useEffect(() => {
    if (sessions.some((session) => session.id === activeSessionId)) {
      return;
    }
    if (sessions.length > 0) {
      setActiveSessionId(sessions[0]?.id ?? "");
      return;
    }
    const session = createSession(t("ask.newChat"));
    updateSessions(() => [session]);
    setActiveSessionId(session.id);
  }, [activeSessionId, sessions, t, updateSessions]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      ASK_ACTIVE_SESSION_STORAGE_KEY,
      activeSessionId,
    );
  }, [activeSessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  });

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!renamingSessionId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingSessionId]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      const remaining = MAX_ATTACHMENTS - attachments.length;
      if (remaining <= 0) {
        toast.error(
          t("ask.toast.tooManyAttachments", { count: MAX_ATTACHMENTS }),
        );
        return;
      }
      if (list.length > remaining) {
        toast.info(t("ask.toast.someAttachmentsSkipped", { count: remaining }));
      }

      const next: ChatAttachment[] = [];
      for (const file of list.slice(0, remaining)) {
        try {
          const attachment = await readAttachment(file, t);
          if (attachment) next.push(attachment);
        } catch {
          toast.error(t("ask.toast.readFailed", { name: file.name }));
        }
      }
      if (next.length > 0) {
        setAttachments((previous) => [...previous, ...next]);
      }
    },
    [attachments.length, t],
  );

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    if (files) {
      await addFiles(files);
    }
    event.currentTarget.value = "";
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    if (controlsDisabled) return;
    if (event.dataTransfer.files.length > 0) {
      await addFiles(event.dataTransfer.files);
    }
  };

  const handlePaste = async (event: ClipboardEvent<HTMLElement>) => {
    if (controlsDisabled) return;
    const files = getClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    await addFiles(files);
  };

  const removeAttachment = (attachmentId: string) => {
    setAttachments((previous) =>
      previous.filter((attachment) => attachment.id !== attachmentId),
    );
  };

  const handleStop = () => {
    if (!activeSession?.id) return;
    askAbortControllers.get(activeSession.id)?.abort();
  };

  const handleSend = useCallback(async () => {
    const targetSessionId = activeSession?.id ?? activeSessionId;
    if (!targetSessionId) return;
    if (sendingSessionIds.has(targetSessionId)) return;
    const targetSessionTitle =
      activeSession?.title ??
      getAskSessionTitle(targetSessionId, t("ask.newChat"));
    if (!isRuntimeReady) {
      toast.info(t("ask.toast.runtimeNotReady"));
      return;
    }
    if (updateModel.isPending) {
      toast.info(t("ask.toast.modelSwitching"));
      return;
    }

    await compactingSessionPromisesRef.current.get(targetSessionId);
    const contextSession =
      getAskSessions(t("ask.newChat")).find(
        (session) => session.id === targetSessionId,
      ) ?? activeSession;
    const contextMessages = contextSession?.messages ?? messages;
    const text = buildDisplayText(input);
    if (!text.trim() && attachments.length === 0) return;

    const workbenchRoute = classifyWorkbenchRequest({
      text,
      attachments,
      permissionMode: localPermissions.mode,
      recentMessages: contextMessages,
    });

    if (!currentModelId) {
      toast.error(t("ask.toast.noModel"));
      navigate("/workspace/models");
      return;
    }

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      text,
      createdAt: Date.now(),
      attachments,
    };
    const assistantMessageId = createId("assistant");
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      modelLabel: getAssistantDisplayName(currentModelId),
      streaming: true,
    };

    const summaryMessage = buildSummaryContextMessage(
      contextSession?.contextSummary,
    );
    const knowledgeMessage = buildKnowledgeContextMessage({
      query: text,
      items: knowledgeItems,
    });
    const history = getMessagesAfterSummary(
      contextMessages,
      contextSession?.summarizedThroughMessageId,
    )
      .map(serializeHistoryMessage)
      .filter((message): message is ChatCompletionMessage => message !== null)
      .slice(-MAX_CONTEXT_MESSAGES);
    const payloadMessages = [
      ...(summaryMessage ? [summaryMessage] : []),
      ...(knowledgeMessage ? [knowledgeMessage] : []),
      ...history,
      buildCurrentUserPayload({ text, attachments }),
    ];
    const recentHistoryContext = buildRecentHistoryContext(contextMessages);
    const agentWorkbenchMessage = buildAgentWorkbenchMessage({
      text,
      attachments,
      summaryMessage,
      knowledgeMessage,
      recentHistoryContext,
    });
    const agentContextBlocks = [
      summaryMessage
        ? `鍘嗗彶鎽樿锛歕n${extractChatContentText(summaryMessage.content)}`
        : "",
      knowledgeMessage
        ? `鐭ヨ瘑搴撹祫鏂欙細\n${extractChatContentText(knowledgeMessage.content)}`
        : "",
      recentHistoryContext ? `鏈€杩戝璇濓細\n${recentHistoryContext}` : "",
    ].filter(Boolean);
    const inputTokenEstimate = estimateTokensFromMessages(payloadMessages);

    updateSessionMessages(targetSessionId, (previous, session) => ({
      title:
        previous.length === 0 && session.titleSource !== "manual"
          ? buildSessionTitle(text, attachments, session.title)
          : session.title,
      titleSource:
        previous.length === 0 && session.titleSource !== "manual"
          ? "auto"
          : session.titleSource,
      messages: [...previous, userMessage, assistantMessage],
    }));
    setInput("");
    setAttachments([]);
    setSessionSending(targetSessionId, true);
    markAskReplyStarted(targetSessionId, targetSessionTitle);

    const controller = new AbortController();
    askAbortControllers.set(targetSessionId, controller);
    let completedForNotification = false;
    const requestStartedAt = Date.now();

    try {
      const response = await fetchAgentChatStream({
        requestId: userMessage.id,
        sessionId: targetSessionId,
        modelId: currentModelId,
        message: limitAgentWorkbenchMessage({
          message: agentWorkbenchMessage,
          contextBlocks: agentContextBlocks,
          currentBlock: `Current user message:\n${
            extractChatContentText(
              buildCurrentUserPayload({ text, attachments }).content,
            ) || text
          }`,
        }),
        attachments,
        permissionMode: localPermissions.mode,
        executionMode:
          workbenchRoute === "write_agent" ||
          workbenchRoute === "image_generation"
            ? "write"
            : "read_only",
        signal: controller.signal,
      });

      const completion = await readStreamedCompletion(response, (delta) => {
        updateSessionMessages(targetSessionId, (previous) => ({
          messages: previous.map((message) =>
            message.id === assistantMessageId
              ? { ...message, text: message.text + delta }
              : message,
          ),
        }));
      });

      if (completion.error) {
        throw new Error(completion.error);
      }
      const finalAssistantText = completion.text || t("ask.emptyResponse");
      const outputTokenEstimate = estimateTokensFromText(finalAssistantText);
      const inputTokens = completion.usage?.promptTokens ?? inputTokenEstimate;
      const outputTokens =
        completion.usage?.completionTokens ?? outputTokenEstimate;
      const totalTokens =
        completion.usage?.totalTokens ?? inputTokens + outputTokens;
      updateSessionMessages(targetSessionId, (previous) => ({
        messages: previous.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                text: message.text || finalAssistantText,
                usage: {
                  inputTokens,
                  outputTokens,
                  totalTokens,
                  estimated: !completion.usage,
                  costYuan: estimateTokenCostYuan({
                    modelId: currentModelId,
                    inputTokens,
                    outputTokens,
                  }),
                },
                durationMs: Date.now() - requestStartedAt,
                streaming: false,
              }
            : message,
        ),
      }));
      void compactSessionIfNeeded({
        sessionId: targetSessionId,
        modelId: currentModelId,
        messages: [
          ...contextMessages,
          userMessage,
          {
            ...assistantMessage,
            text: finalAssistantText,
            streaming: false,
          },
        ],
        contextSummary: contextSession?.contextSummary,
        summarizedThroughMessageId: contextSession?.summarizedThroughMessageId,
      });
      completedForNotification = true;
    } catch (error) {
      const aborted =
        error instanceof DOMException && error.name === "AbortError";
      const errorMessage =
        error instanceof Error && error.message.trim()
          ? normalizeWorkbenchErrorMessage(error.message.trim())
          : t("ask.toast.sendFailed");
      const failedText =
        errorMessage === INSUFFICIENT_BALANCE_MESSAGE
          ? errorMessage
          : workbenchRoute === "image_generation"
            ? t("ask.imageFailed", { message: errorMessage })
            : t("ask.requestFailed", { message: errorMessage });
      updateSessionMessages(targetSessionId, (previous) => ({
        messages: previous.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                text: message.text || (aborted ? t("ask.stopped") : failedText),
                durationMs: Date.now() - requestStartedAt,
                streaming: false,
              }
            : message,
        ),
      }));
      if (!aborted) {
        toast.error(errorMessage);
      }
    } finally {
      askAbortControllers.delete(targetSessionId);
      setSessionSending(targetSessionId, false);
      markAskReplyFinished({
        sessionId: targetSessionId,
        title: getAskSessionTitle(targetSessionId, t("ask.newChat")),
        markUnread:
          completedForNotification && !isAskSessionVisible(targetSessionId),
      });
    }
  }, [
    activeSession,
    activeSessionId,
    attachments,
    compactSessionIfNeeded,
    currentModelId,
    input,
    isRuntimeReady,
    knowledgeItems,
    localPermissions.mode,
    messages,
    navigate,
    sendingSessionIds,
    setSessionSending,
    t,
    updateModel.isPending,
    updateSessionMessages,
  ]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col bg-[#101114]",
        isDraggingFile &&
          "ring-2 ring-inset ring-[var(--color-brand-primary)]/40",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        if (!controlsDisabled) setIsDraggingFile(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setIsDraggingFile(false);
      }}
      onDrop={(event) => void handleDrop(event)}
      onPaste={(event) => void handlePaste(event)}
    >
      {isConfigRestartDeferred ? (
        <output className="block border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200">
          {t("ask.configUpdateDeferred")}
        </output>
      ) : null}
      {contextMenu && contextMenuSession ? (
        <div
          role="menu"
          tabIndex={-1}
          className="fixed z-50 w-36 overflow-hidden rounded-lg border border-border bg-surface-0 py-1 shadow-xl"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => startRenamingSession(contextMenuSession)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
          >
            <Pencil size={13} />
            {t("ask.renameChat")}
          </button>
          <button
            type="button"
            onClick={() => deleteSession(contextMenuSession.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-red-500 transition-colors hover:bg-red-500/10"
          >
            <Trash2 size={13} />
            {t("ask.deleteChat")}
          </button>
        </div>
      ) : null}
      {previewImage ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-surface-0 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 truncate text-[13px] font-medium text-text-primary">
                {previewImage.name}
              </div>
              <button
                type="button"
                onClick={() => setPreviewImage(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                aria-label={t("modal.close")}
                title={t("modal.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-black/25 p-4">
              <img
                src={previewImage.src}
                alt={previewImage.name}
                className="mx-auto max-h-[72vh] max-w-full rounded-lg object-contain"
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => void handlePreviewCopyImage()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
              >
                <Copy size={13} />
                {t("ask.copyImage")}
              </button>
              <button
                type="button"
                onClick={() => void handlePreviewDownloadImage()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
              >
                <Download size={13} />
                {t("ask.downloadImage")}
              </button>
              <button
                type="button"
                onClick={() =>
                  window.open(previewImage.src, "_blank", "noopener,noreferrer")
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-brand-primary)] px-3 text-[12px] font-medium text-white transition-colors hover:opacity-90"
              >
                <Maximize2 size={13} />
                {t("ask.openOriginal")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {knowledgeOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
          <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface-0 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="text-[14px] font-semibold text-text-primary">
                  {t("ask.knowledgeBase")}
                </div>
                <div className="text-[11px] text-text-muted">
                  {t("ask.knowledgeHint")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setKnowledgeOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                aria-label={t("modal.close")}
                title={t("modal.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <input
                ref={knowledgeFileInputRef}
                type="file"
                multiple
                className="hidden"
                accept="text/*,.txt,.md,.csv,.json,.log,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.cpp,.c,.sql"
                onChange={(event) => {
                  if (event.currentTarget.files) {
                    void addKnowledgeFiles(event.currentTarget.files);
                  }
                  event.currentTarget.value = "";
                }}
              />
              <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                <div className="space-y-2">
                  <input
                    value={knowledgeTitle}
                    onChange={(event) => setKnowledgeTitle(event.target.value)}
                    placeholder={t("ask.knowledgeTitlePlaceholder")}
                    className="h-9 w-full rounded-md border border-border bg-surface-1 px-3 text-[12px] text-text-primary outline-none placeholder:text-text-muted focus:border-[var(--color-brand-primary)]/45"
                  />
                  <textarea
                    value={knowledgeContent}
                    onChange={(event) =>
                      setKnowledgeContent(event.target.value)
                    }
                    placeholder={t("ask.knowledgeContentPlaceholder")}
                    className="min-h-40 w-full resize-y rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-[var(--color-brand-primary)]/45"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={saveKnowledgeItem}
                      className="inline-flex h-8 flex-1 items-center justify-center rounded-md bg-[var(--color-brand-primary)] px-3 text-[12px] font-medium text-white transition-colors hover:opacity-90"
                    >
                      {t("ask.knowledgeSave")}
                    </button>
                    <button
                      type="button"
                      onClick={() => knowledgeFileInputRef.current?.click()}
                      className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-[12px] text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary"
                    >
                      <Paperclip size={13} />
                    </button>
                  </div>
                </div>
                <div className="min-h-0 space-y-2">
                  {knowledgeItems.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-8 text-center text-[12px] text-text-muted">
                      {t("ask.knowledgeEmpty")}
                    </div>
                  ) : (
                    knowledgeItems.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-lg border border-border bg-surface-1 p-3"
                      >
                        <div className="flex items-start gap-2">
                          <label className="mt-0.5 flex items-center gap-2 text-[12px] font-medium text-text-primary">
                            <input
                              type="checkbox"
                              checked={item.enabled}
                              onChange={(event) =>
                                setKnowledgeItems((previous) =>
                                  previous.map((entry) =>
                                    entry.id === item.id
                                      ? {
                                          ...entry,
                                          enabled: event.target.checked,
                                          updatedAt: Date.now(),
                                        }
                                      : entry,
                                  ),
                                )
                              }
                            />
                            <span className="line-clamp-1">{item.title}</span>
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setKnowledgeItems((previous) =>
                                previous.filter(
                                  (entry) => entry.id !== item.id,
                                ),
                              )
                            }
                            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                            aria-label={t("ask.knowledgeDelete")}
                            title={t("ask.knowledgeDelete")}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-text-muted">
                          {item.content}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <header className="shrink-0 border-b border-[#262b35] bg-[#111318]/95 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#2a303a] bg-[#171a21] text-text-secondary">
                <MessageCircle size={15} />
              </span>
              <div className="min-w-0">
                <h1 className="text-[16px] font-semibold text-text-primary">
                  {t("ask.title")}
                </h1>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ModelPickerDropdown
              compact
              confirmSwitch
              models={pickerModels}
              currentModelId={currentModelId}
              emptyLabel={t("models.noModelConfigured")}
              onSelectModel={(modelId) => updateModel.mutate(modelId)}
              onOpenSettings={() => navigate("/workspace/models")}
              triggerClassName="min-h-9 min-w-[132px] justify-between px-3"
              dropdownAlign="end"
            />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-[#262b35] bg-[#0d0f13]/95 transition-[width] duration-200 lg:flex",
            sessionsCollapsed ? "w-12 p-2" : "w-64 p-3",
          )}
        >
          {sessionsCollapsed ? (
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => setSessionsCollapsed(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                aria-label={t("ask.expandSessions")}
                title={t("ask.expandSessions")}
              >
                <PanelLeftOpen size={15} />
              </button>
              <button
                type="button"
                onClick={createNewSession}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                aria-label={t("ask.newChat")}
                title={t("ask.newChat")}
              >
                <Plus size={15} />
              </button>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-[12px] font-semibold text-text-secondary">
                  {t("ask.sessions")}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setSessionsCollapsed(true)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                    aria-label={t("ask.collapseSessions")}
                    title={t("ask.collapseSessions")}
                  >
                    <PanelLeftClose size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={createNewSession}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                    aria-label={t("ask.newChat")}
                    title={t("ask.newChat")}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {sortedSessions.map((session) => {
                  const sessionIsSending = sendingSessionIds.has(session.id);
                  const sessionIsUnread = unreadSessionIds.has(session.id);
                  const isRenaming = renamingSessionId === session.id;
                  return (
                    <div
                      key={session.id}
                      onContextMenu={(event) =>
                        openSessionMenu(event, session.id)
                      }
                      className={cn(
                        "group flex items-center gap-1 rounded-lg p-1 transition-colors",
                        session.id === activeSession?.id
                          ? "bg-[#1b1f27] text-text-primary"
                          : "text-text-secondary hover:bg-[#151820] hover:text-text-primary",
                      )}
                    >
                      {isRenaming ? (
                        <form
                          onSubmit={handleRenameSubmit}
                          className="min-w-0 flex-1"
                        >
                          <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(event) =>
                              setRenameValue(event.target.value)
                            }
                            onBlur={finishRenamingSession}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setRenamingSessionId(null);
                                setRenameValue("");
                              }
                            }}
                            className="h-9 w-full rounded-md border border-[var(--color-brand-primary)]/35 bg-surface-0 px-2 text-[12px] font-medium text-text-primary outline-none"
                          />
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActiveSessionId(session.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left"
                        >
                          <span className="relative shrink-0">
                            {sessionIsSending ? (
                              <Loader2
                                size={14}
                                className="animate-spin text-[var(--color-brand-primary)]"
                              />
                            ) : (
                              <MessageCircle
                                size={14}
                                className={cn(
                                  "text-text-muted",
                                  sessionIsUnread &&
                                    "text-[var(--color-brand-primary)]",
                                )}
                              />
                            )}
                            {sessionIsUnread && !sessionIsSending ? (
                              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-brand-primary)]" />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-medium">
                              {session.title}
                            </span>
                            <span className="mt-0.5 block text-[10px] text-text-muted">
                              {sessionIsSending
                                ? t("ask.running")
                                : formatSessionTime(session.updatedAt)}
                            </span>
                          </span>
                        </button>
                      )}
                      {!isRenaming && (
                        <>
                          <button
                            type="button"
                            onClick={() => startRenamingSession(session)}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:bg-surface-0 hover:text-text-primary group-hover:opacity-100"
                            aria-label={t("ask.renameChat")}
                            title={t("ask.renameChat")}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteSession(session.id)}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 transition-all hover:bg-surface-0 hover:text-text-primary group-hover:opacity-100"
                            aria-label={t("ask.deleteChat")}
                            title={t("ask.deleteChat")}
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#101114] px-4 py-5 md:px-6">
            <div className="mx-auto min-h-full w-full max-w-4xl">
              {messages.length === 0 ? (
                <div className="min-h-[360px]" />
              ) : (
                <div className="space-y-1">
                  {messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      assistantLabel={assistantLabel}
                      onPreviewImage={setPreviewImage}
                    />
                  ))}
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <div className="shrink-0 bg-[#101114] px-4 pb-4 pt-2 md:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {runtimeNotice ? (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--color-warning)]/25 bg-[var(--color-warning)]/10 px-3 py-2 text-[12px] text-text-secondary">
                  <Loader2
                    size={13}
                    className="shrink-0 animate-spin text-[var(--color-warning)]"
                  />
                  <span className="min-w-0 flex-1">{runtimeNotice}</span>
                </div>
              ) : null}
              {attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="flex max-w-[260px] items-center gap-2 rounded-md border border-white/10 bg-[#18191d] px-2.5 py-1.5 text-[11px] text-text-secondary"
                    >
                      <AttachmentIcon kind={attachment.kind} />
                      <span className="min-w-0 flex-1 truncate">
                        {attachment.name}
                      </span>
                      <span className="shrink-0 text-text-muted">
                        {formatBytes(attachment.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(attachment.id)}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
                        aria-label={t("ask.removeAttachment")}
                        title={t("ask.removeAttachment")}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="relative rounded-2xl border border-white/15 bg-[#1a1a1c] px-4 py-3 transition-colors focus-within:border-white/25">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept="image/*,video/*,text/*,.txt,.md,.csv,.json,.log,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.cpp,.c,.sql,.pdf,.doc,.docx,.xlsx,.ppt,.pptx"
                  onChange={handleFileChange}
                />
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={controlsDisabled}
                  placeholder={
                    isRuntimeReady
                      ? t("ask.placeholder")
                      : t("ask.placeholderStarting")
                  }
                  rows={1}
                  className="max-h-36 min-h-12 w-full resize-none bg-transparent px-0 py-0 text-[14px] leading-6 text-text-primary outline-none placeholder:text-text-muted disabled:opacity-60"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    <ModelPickerDropdown
                      compact
                      confirmSwitch
                      models={pickerModels}
                      currentModelId={currentModelId}
                      emptyLabel={t("models.noModelConfigured")}
                      onSelectModel={(modelId) => updateModel.mutate(modelId)}
                      onOpenSettings={() => navigate("/workspace/models")}
                      triggerClassName="h-8 max-w-[180px] !border-transparent !bg-transparent px-2.5 hover:!bg-[#25262a]"
                      dropdownAlign="start"
                      dropdownPlacement="top"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmAction(null);
                        setLocalPermissionsOpen((open) => !open);
                      }}
                      className={cn(
                        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[#25262a] hover:text-text-primary",
                        localPermissions.mode !== "basic"
                          ? "text-[var(--color-brand-primary)]"
                          : "text-text-muted",
                      )}
                      aria-label={t("ask.local.permissions")}
                      title={t("ask.local.permissions")}
                      aria-pressed={localPermissions.mode !== "basic"}
                    >
                      <ShieldCheck size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={controlsDisabled}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[#25262a] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t("ask.attach")}
                      title={t("ask.attach")}
                    >
                      <Paperclip size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setKnowledgeOpen(true)}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors hover:bg-[#25262a] hover:text-text-primary",
                        knowledgeItems.some((item) => item.enabled)
                          ? "text-[var(--color-brand-primary)]"
                          : "text-text-muted",
                      )}
                      aria-label={t("ask.knowledgeBase")}
                      title={t("ask.knowledgeBase")}
                    >
                      <BookOpen size={15} />
                      <span className="hidden sm:inline">
                        {knowledgeItems.filter((item) => item.enabled).length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmAction("clearContext")}
                      disabled={
                        !activeSession || activeSession.messages.length === 0
                      }
                      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] text-text-muted transition-colors hover:bg-[#25262a] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                      aria-label={t("ask.clearContext")}
                      title={t("ask.clearContext")}
                    >
                      <RotateCcw size={15} />
                      <span className="hidden sm:inline">
                        {t("ask.clearContextShort")}
                      </span>
                    </button>
                    {messages.length > 0 && !activeSessionIsSending ? (
                      <button
                        type="button"
                        onClick={() => setConfirmAction("clearChat")}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[#25262a] hover:text-text-primary"
                        aria-label={t("ask.clear")}
                        title={t("ask.clear")}
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                  {localPermissionsOpen ? (
                    <div className="absolute bottom-12 left-2 z-50 w-[360px] rounded-xl border border-[#303642] bg-[#171a20] p-3 shadow-2xl">
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand-primary)]/15 text-[var(--color-brand-primary)]">
                          <ShieldCheck size={15} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-text-primary">
                            {t("ask.local.title")}
                          </div>
                          <p className="mt-1 text-[11px] leading-5 text-text-muted">
                            {t("ask.local.desc")}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-1.5">
                        {[
                          {
                            key: "basic",
                            label: t("ask.local.mode.basic"),
                            desc: t("ask.local.mode.basicDesc"),
                            icon: ShieldCheck,
                          },
                          {
                            key: "confirm",
                            label: t("ask.local.mode.confirm"),
                            desc: t("ask.local.mode.confirmDesc"),
                            icon: FolderPlus,
                          },
                          {
                            key: "full",
                            label: t("ask.local.mode.full"),
                            desc: t("ask.local.mode.fullDesc"),
                            icon: Globe2,
                          },
                        ].map((item) => {
                          const Icon = item.icon;
                          const mode = item.key as LocalDesktopPermissionMode;
                          const selected = localPermissions.mode === mode;
                          return (
                            <button
                              key={item.key}
                              type="button"
                              onClick={() =>
                                setLocalPermissions((previous) => ({
                                  ...previous,
                                  mode,
                                }))
                              }
                              className={cn(
                                "flex min-h-[92px] flex-col items-start rounded-lg border p-2 text-left transition-colors hover:bg-[#242933]",
                                selected
                                  ? "border-[var(--color-brand-primary)]/70 bg-[var(--color-brand-primary)]/10 text-text-primary"
                                  : "border-white/10 bg-white/[0.02] text-text-secondary",
                              )}
                            >
                              <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                                <Icon size={14} />
                                <span>{item.label}</span>
                              </span>
                              <span className="mt-1 text-[10px] leading-4 text-text-muted">
                                {item.desc}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-text-muted">
                        {[
                          {
                            icon: Globe2,
                            label: t("ask.local.capability.upload"),
                          },
                          {
                            icon: FolderPlus,
                            label: t("ask.local.capability.web"),
                          },
                          {
                            icon: FileSpreadsheet,
                            label: t("ask.local.capability.workspace"),
                          },
                        ].map(({ icon: CapabilityIcon, label }) => {
                          return (
                            <span
                              key={label}
                              className="inline-flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-1"
                            >
                              <CapabilityIcon size={11} />
                              {label}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {confirmAction ? (
                    <div className="absolute bottom-12 left-2 z-50 w-[220px] rounded-lg border border-[#303642] bg-[#1a1e26] p-3 shadow-2xl">
                      <div className="text-[12px] font-medium text-text-primary">
                        {confirmAction === "clearChat"
                          ? t("ask.confirm.clearChat")
                          : t("ask.confirm.clearContext")}
                      </div>
                      <div className="mt-2 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmAction(null)}
                          className="h-7 rounded-md px-2.5 text-[12px] text-text-muted transition-colors hover:bg-[#252b35] hover:text-text-primary"
                        >
                          {t("ask.confirm.cancel")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirmAction === "clearChat") {
                              clearCurrentChat();
                            } else {
                              clearCurrentContext();
                            }
                            setConfirmAction(null);
                          }}
                          className="h-7 rounded-md bg-red-500/15 px-2.5 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/25"
                        >
                          {t("ask.confirm.confirm")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {activeSessionIsSending ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/85 text-[#111318] transition-colors hover:bg-white"
                      aria-label={t("ask.stop")}
                      title={t("ask.stop")}
                    >
                      <Square size={13} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleSend()}
                      disabled={
                        controlsDisabled ||
                        (!input.trim() && attachments.length === 0)
                      }
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-text-primary transition-colors hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={t("ask.send")}
                      title={t("ask.send")}
                    >
                      <Send size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
