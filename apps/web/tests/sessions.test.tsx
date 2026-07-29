import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionsPage } from "../src/pages/sessions";

vi.mock("@/lib/tracking", () => ({
  track: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "sessions.chat.messages" && values?.count != null) {
        return `${String(values.count)} messages`;
      }
      if (key === "sessions.chat.lastActive" && values?.time != null) {
        return `Last active ${String(values.time)}`;
      }
      if (key === "sessions.chat.toolActivity") {
        return "Localized Tool Activity";
      }
      if (key === "sessions.chat.toolCompleted") {
        return "Completed";
      }
      if (key === "sessions.chat.replyLabel") {
        return "Localized Reply";
      }
      return key;
    },
  }),
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Channels: vi.fn(async () => ({
    data: undefined,
  })),
  getApiV1SessionsById: vi.fn(async () => ({
    data: undefined,
  })),
  getApiV1SessionsByIdMessages: vi.fn(async () => ({
    data: undefined,
  })),
}));

function renderSessionsPage(): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  queryClient.setQueryData(["session-meta", "sess-1"], {
    id: "sess-1",
    title: "Alex DM",
    channelType: "slack",
    messageCount: 2,
    lastMessageAt: "2026-03-20T08:58:00.000Z",
    metadata: {
      isGroup: false,
    },
  });
  queryClient.setQueryData(["chat-history", "sess-1"], {
    messages: [
      {
        id: "msg-1",
        role: "user",
        content:
          "[message_id: 123]\\nAlex: Can you summarize tomorrow's meetings?",
        timestamp: new Date("2026-03-20T08:57:00.000Z").getTime(),
        createdAt: "2026-03-20T08:57:00.000Z",
      },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Sure. I checked your calendar and drafted the summary.",
          },
          {
            type: "toolCall",
            name: "google-calendar",
          },
        ],
        timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
        createdAt: "2026-03-20T08:58:00.000Z",
      },
    ],
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/workspace/sessions/sess-1"]}>
        <Routes>
          <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SessionsPage", () => {
  it("renders a structured session header and cleaned transcript", () => {
    const markup = renderSessionsPage();

    expect(markup).toContain('data-session-platform="slack"');
    expect(markup).toContain('data-chat-thread="sess-1"');
    expect(markup).toContain("<title>Slack</title>");
    expect(markup).toContain("<p>Can you summarize tomorrow's meetings?</p>");
    expect(markup).not.toContain("[message_id:");
    expect(markup).toContain("google-calendar");
    expect(markup).toContain("Open in Slack");
  });

  it("renders assistant tool activity as a compact execution chip", () => {
    const markup = renderSessionsPage();

    expect(markup).toContain('data-chat-layout="centered"');
    expect(markup).toContain('data-tool-card="google-calendar"');
    expect(markup).toContain('data-tool-card-variant="inline-chip"');
    expect(markup).toContain(">Completed<");
    expect(markup).toContain("Google Calendar");
    expect(markup).not.toContain(">Localized Tool Activity<");
  });

  it("renders markdown formatting with safe links and escaped raw html", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-markdown"], {
      id: "sess-markdown",
      title: "Markdown check",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-22T15:00:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-markdown"], {
      messages: [
        {
          id: "msg-markdown",
          role: "assistant",
          content:
            "**bold** [docs](https://example.com) `inline`\n\n<script>alert('xss')</script>",
          timestamp: new Date("2026-03-22T15:00:00.000Z").getTime(),
          createdAt: "2026-03-22T15:00:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-markdown"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<code>inline</code>");
    expect(markup).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">',
    );
    expect(markup).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
  });

  it("does not render markdown image syntax as an img tag", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-markdown-image"], {
      id: "sess-markdown-image",
      title: "Markdown image check",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-23T03:20:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-markdown-image"], {
      messages: [
        {
          id: "msg-markdown-image",
          role: "assistant",
          content: "![tracker](https://example.com/pixel)",
          timestamp: new Date("2026-03-23T03:20:00.000Z").getTime(),
          createdAt: "2026-03-23T03:20:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={["/workspace/sessions/sess-markdown-image"]}
        >
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).not.toContain('<img src="https://example.com/pixel"');
    expect(markup).toContain("https://example.com/pixel");
    expect(markup).not.toContain('href="https://example.com/pixel"');
  });

  it("strips conversation metadata blocks before rendering user text", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-meta-only"], {
      id: "sess-meta-only",
      title: "测试",
      channelType: "web",
      messageCount: 1,
      lastMessageAt: "2026-03-22T10:49:06.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-meta-only"], {
      messages: [
        {
          id: "msg-meta-only",
          role: "user",
          content:
            'Conversation info (untrusted metadata):\n```json\n{\n  "message_id": "openclaw-weixin:1774176546217-9644087e",\n  "timestamp": "Sun 2026-03-22 18:49 GMT+8"\n}\n```\n\n测试',
          timestamp: new Date("2026-03-22T10:49:06.000Z").getTime(),
          createdAt: "2026-03-22T10:49:06.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-meta-only"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain("测试");
    expect(markup).not.toContain("Conversation info (untrusted metadata)");
    expect(markup).not.toContain("openclaw-weixin:1774176546217-9644087e");
  });

  it("hides 龙虾工作台 injected system prompts and shows only the user text", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-workbench"], {
      id: "sess-workbench",
      title: "工作台",
      channelType: "web",
      messageCount: 2,
      lastMessageAt: "2026-03-22T10:49:06.000Z",
      metadata: {},
    });
    const wrapped = [
      "以下为龙虾工作台注入的运行约束，优先级高于用户当前消息：",
      "你是 OpenClaw 龙虾 agent，必须通过 OpenClaw runner 完成工作台任务；不要退化成普通聊天模型。\n\n权限=完全访问：用户要求操作电脑、读写文件时，直接使用可用工具执行。",
      "用户当前消息如下：",
      [
        "以下是龙虾工作台传入的上下文，只用于理解当前问题；真正要回答的是最后的用户当前消息。",
        "最近对话：\n用户：帮我生成一张写真照",
        "用户当前消息：\n帮我换一个背景",
      ].join("\n\n"),
    ].join("\n\n");
    queryClient.setQueryData(["chat-history", "sess-workbench"], {
      messages: [
        {
          id: "msg-wrapped",
          role: "user",
          content: wrapped,
          timestamp: new Date("2026-03-22T10:49:06.000Z").getTime(),
          createdAt: "2026-03-22T10:49:06.000Z",
        },
        {
          id: "msg-directive",
          role: "user",
          content:
            "继续执行当前任务。不要只回复计划、状态或道歉；需要本机/文件/网页/生图操作时，立即调用 OpenClaw 可用工具完成。",
          timestamp: new Date("2026-03-22T10:50:06.000Z").getTime(),
          createdAt: "2026-03-22T10:50:06.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-workbench"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain("帮我换一个背景");
    expect(markup).not.toContain("龙虾工作台注入的运行约束");
    expect(markup).not.toContain("权限=完全访问");
    expect(markup).not.toContain("OpenClaw runner");
    // The pure auto-continue directive collapses to empty text and is filtered.
    expect(markup).not.toContain("继续执行当前任务");
  });

  it("renders a Feishu deep link when the backing channel config is available", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-2"], {
      id: "sess-2",
      botId: "bot-feishu",
      sessionKey: "sess-2",
      channelId: "channel-feishu-1",
      title: "唐其远",
      channelType: "feishu",
      messageCount: 1,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {
        path: "/Users/qiyuan/.openclaw/agents/bot-feishu/sessions/sess-2.jsonl",
        openChatId: "oc_41e7bdf4877cfc316136f4ccf6c32613",
      },
    });
    queryClient.setQueryData(["chat-history", "sess-2"], {
      messages: [
        {
          id: "msg-3",
          role: "assistant",
          content: "Hello from Feishu",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], {
      channels: [
        {
          id: "channel-feishu-1",
          channelType: "feishu",
          accountId: "feishu:cli_xxx",
          teamName: "Feishu Team",
          appId: "cli_xxx",
          botUserId: null,
          status: "connected",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-2"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain(
      'href="https://applink.feishu.cn/client/chat/open?openChatId=oc_41e7bdf4877cfc316136f4ccf6c32613"',
    );
    expect(markup).toContain("Open in Feishu");
    expect(markup).toContain("Open Folder");
    expect(markup).toContain(
      'data-session-folder-url="file:///Users/qiyuan/.openclaw/agents/bot-feishu/sessions"',
    );
  });

  it("does not render a wrong Feishu deep link when exact chat metadata is missing", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-3"], {
      id: "sess-3",
      botId: "bot-feishu",
      sessionKey: "sess-3",
      channelId: "channel-feishu-1",
      title: "唐其远",
      channelType: "feishu",
      messageCount: 1,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {
        path: "/Users/qiyuan/.openclaw/agents/bot-feishu/sessions/sess-3.jsonl",
        openId: "ou_00c644f271002b17348e992569f0f327",
      },
    });
    queryClient.setQueryData(["chat-history", "sess-3"], {
      messages: [
        {
          id: "msg-4",
          role: "assistant",
          content: "Hello from Feishu DM",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], {
      channels: [
        {
          id: "channel-feishu-1",
          channelType: "feishu",
          accountId: "feishu:cli_xxx",
          teamName: "Feishu Team",
          appId: "cli_xxx",
          botUserId: null,
          status: "connected",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-3"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain("Open in Feishu");
    expect(markup).not.toContain(
      'href="https://applink.feishu.cn/client/chat/open?openId=ou_00c644f271002b17348e992569f0f327"',
    );
    expect(markup).not.toContain(
      'href="https://applink.feishu.cn/client/bot/open?appId=cli_xxx"',
    );
  });

  it("renders WhatsApp session headers with the platform icon and open-chat action", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-whatsapp"], {
      id: "sess-whatsapp",
      botId: "bot-whatsapp",
      sessionKey: "sess-whatsapp",
      channelId: "channel-whatsapp-1",
      title: "Alice",
      channelType: "whatsapp",
      messageCount: 5,
      lastMessageAt: "2026-03-20T08:58:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-whatsapp"], {
      messages: [
        {
          id: "msg-whatsapp-1",
          role: "assistant",
          content: "Hello from WhatsApp",
          timestamp: new Date("2026-03-20T08:58:00.000Z").getTime(),
          createdAt: "2026-03-20T08:58:00.000Z",
        },
      ],
    });
    queryClient.setQueryData(["channels"], {
      channels: [
        {
          id: "channel-whatsapp-1",
          channelType: "whatsapp",
          accountId: "whatsapp-default",
          teamName: "WhatsApp",
          appId: null,
          botUserId: null,
          status: "connected",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-whatsapp"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-session-platform="whatsapp"');
    expect(markup).toContain("<title>WhatsApp</title>");
    expect(markup).toContain("WhatsApp · 5 messages");
    expect(markup).toContain('href="https://web.whatsapp.com/"');
    expect(markup).toContain("Open in WhatsApp");
  });

  it("strips assistant reply markers and keeps tool-only activity visible", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-tool"], {
      id: "sess-tool",
      title: "Feishu cleanup",
      channelType: "feishu",
      messageCount: 2,
      lastMessageAt: "2026-03-23T03:20:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-tool"], {
      messages: [
        {
          id: "msg-prefix",
          role: "assistant",
          content: "[[reply_to_current]] 已处理完成，全部状态已修正为已上线。",
          timestamp: new Date("2026-03-23T03:19:00.000Z").getTime(),
          createdAt: "2026-03-23T03:19:00.000Z",
        },
        {
          id: "msg-tool-only",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "feishu_bitable_list_records",
            },
          ],
          timestamp: new Date("2026-03-23T03:20:00.000Z").getTime(),
          createdAt: "2026-03-23T03:20:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-tool"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain("已处理完成，全部状态已修正为已上线。");
    expect(markup).not.toContain("[[reply_to_current]]");
    expect(markup).toContain('data-tool-card="feishu_bitable_list_records"');
    expect(markup).toContain("Feishu Bitable List Records");
  });

  it("falls back to the localized tool label for placeholder tool names", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-tool-fallback"], {
      id: "sess-tool-fallback",
      title: "Placeholder tool names",
      channelType: "web",
      messageCount: 2,
      lastMessageAt: "2026-03-23T03:35:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-tool-fallback"], {
      messages: [
        {
          id: "msg-placeholder-name",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "tool",
            },
          ],
          timestamp: new Date("2026-03-23T03:34:00.000Z").getTime(),
          createdAt: "2026-03-23T03:34:00.000Z",
        },
        {
          id: "msg-separator-name",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "---",
            },
          ],
          timestamp: new Date("2026-03-23T03:35:00.000Z").getTime(),
          createdAt: "2026-03-23T03:35:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter
          initialEntries={["/workspace/sessions/sess-tool-fallback"]}
        >
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const fallbackMatches = markup.match(/Localized Tool Activity/g) ?? [];

    expect(markup).toContain('data-tool-card="tool"');
    expect(markup).toContain('data-tool-card="---"');
    expect(markup).not.toContain(">Tool<");
    expect(fallbackMatches).toHaveLength(2);
  });

  it("renders reply context as quote UI instead of raw metadata", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    queryClient.setQueryData(["session-meta", "sess-reply"], {
      id: "sess-reply",
      title: "Feishu reply",
      channelType: "feishu",
      messageCount: 1,
      lastMessageAt: "2026-03-23T03:25:00.000Z",
      metadata: {},
    });
    queryClient.setQueryData(["chat-history", "sess-reply"], {
      messages: [
        {
          id: "msg-reply-context",
          role: "user",
          content: [
            {
              type: "replyContext",
              text: "[Interactive Card]",
            },
            {
              type: "text",
              text: "你是谁",
            },
          ],
          timestamp: new Date("2026-03-23T03:25:00.000Z").getTime(),
          createdAt: "2026-03-23T03:25:00.000Z",
        },
      ],
    });

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/sessions/sess-reply"]}>
          <Routes>
            <Route path="/workspace/sessions/:id" element={<SessionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-reply-context="[Interactive Card]"');
    expect(markup).toContain("Interactive Card");
    expect(markup).toContain("你是谁");
    expect(markup).toContain("Localized Reply");
    expect(markup).not.toContain(">Reply<");
    expect(markup).not.toContain(
      "[Replying to: &quot;[Interactive Card]&quot;]",
    );
  });
});
