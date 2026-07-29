import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import type { OpenClawGatewayEvent } from "../src/runtime/openclaw-ws-client.js";
import { AgentChatService } from "../src/services/agent-chat-service.js";

type RequestRecord = {
  method: string;
  params: Record<string, unknown>;
};

class FakeOpenClawWsClient {
  connected = true;
  requests: RequestRecord[] = [];
  listeners = new Set<(event: OpenClawGatewayEvent) => void>();

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(listener: (event: OpenClawGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requests.push({ method, params });
    if (method === "agent") {
      return { runId: params.idempotencyKey, status: "started" };
    }
    return { ok: true };
  }

  emit(event: OpenClawGatewayEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

describe("AgentChatService", () => {
  let rootDir: string;
  let fakeWs: FakeOpenClawWsClient;
  let service: AgentChatService;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-agent-chat-"));
    fakeWs = new FakeOpenClawWsClient();
    service = new AgentChatService(
      fakeWs as never,
      {
        openclawStateDir: path.join(rootDir, ".openclaw"),
      } as ControllerEnv,
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("streams workbench replies through OpenClaw agent runner", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-1",
      message: "帮我在桌面创建一个 Excel 表格",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    expect(
      fakeWs.requests.some((request) => request.method === "sessions.patch"),
    ).toBe(false);

    const send = fakeWs.requests.find((request) => request.method === "agent");
    expect(send?.params).toMatchObject({
      sessionKey: "agent:bot-1:workbench:session-1",
      deliver: false,
      extraSystemPrompt: expect.stringContaining("OpenClaw 龙虾 agent"),
      bootstrapContextMode: "lightweight",
    });
    expect(String(send?.params.extraSystemPrompt)).toContain(
      "计划或进度说明作为最终答复",
    );
    expect(String(send?.params.message)).toContain("完全访问");
    expect(String(send?.params.message)).toContain("OpenClaw 龙虾 agent");
    expect(String(send?.params.message)).toContain("不要退化成普通聊天模型");
    expect(String(send?.params.message)).toContain(
      "帮我在桌面创建一个 Excel 表格",
    );

    const runId = String(send?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-1",
        runId,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已创建" }],
        },
      },
    });
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-1",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已创建" }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain('"content":"已创建"');
    expect(body).toContain("data: [DONE]");
  });

  it("sends chat directly without blocking on session model patch", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-1",
      message: "总结这个 Excel",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    expect(
      fakeWs.requests.some((request) => request.method === "sessions.patch"),
    ).toBe(false);
    expect(fakeWs.requests.some((request) => request.method === "agent")).toBe(
      true,
    );
  });

  it("waits through an empty OpenClaw final and adopts the real session run", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-1",
      message: "hi",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const runId = String(send?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-1",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [],
        },
      },
    });
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-1",
        runId: "openclaw-inner-run",
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "真正回复" }],
        },
      },
    });
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-1",
        runId: "openclaw-inner-run",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "真正回复" }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain('"content":"真正回复"');
    expect(body).toContain("data: [DONE]");
  });

  it("auto-continues progress-only final replies in one stream", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-progress",
      message: "帮我总结桌面简历",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const initialSend = fakeWs.requests.find(
      (request) => request.method === "agent",
    );
    const runId = String(initialSend?.params.idempotencyKey);

    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-progress",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "我先在桌面查找简历文件，然后继续处理。",
            },
          ],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const followupSend = fakeWs.requests
      .filter((request) => request.method === "agent")
      .find((request) => String(request.params.idempotencyKey) !== runId);
    expect(followupSend).toBeTruthy();

    const followupRunId = String(followupSend?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-progress",
        runId: followupRunId,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成总结：" }],
        },
      },
    });
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-progress",
        runId: followupRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成总结：候选人经验..." }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("我先在桌面查找简历文件");
    expect(body).toContain("已完成总结：");
    expect(body).toContain("候选人经验...");
    expect(body).toContain("data: [DONE]");
  });

  it("adds read-only constraints for analysis-only workbench agent tasks", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-readonly",
      message: "总结桌面的 PDF",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
      executionMode: "read_only",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    expect(String(send?.params.extraSystemPrompt)).toContain(
      "执行模式=只读分析",
    );
    expect(String(send?.params.extraSystemPrompt)).toContain(
      "不要创建、写入、编辑、保存、导出或覆盖任何用户文件",
    );
    expect(String(send?.params.message)).toContain("执行模式=只读分析");
  });

  it("promotes explicit spreadsheet edit requests to write execution", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-row-edit",
      message:
        "帮我加一行 手机号13510396008，名称djj，地址是成都武侯",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
      executionMode: "read_only",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    expect(String(send?.params.extraSystemPrompt)).toContain(
      "执行模式=可写执行",
    );
    expect(String(send?.params.extraSystemPrompt)).not.toContain(
      "执行模式=只读分析",
    );
    expect(String(send?.params.message)).toContain("完全访问");
    expect(String(send?.params.message)).toContain("执行模式=可写执行");
  });

  it("surfaces insufficient balance errors as a user-facing reply", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-balance",
      message: "你好",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const runId = String(send?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-balance",
        runId,
        state: "error",
        errorMessage:
          "403 token quota is not enough, token remain quota: $0.1, need quota: $0.4",
      },
    });

    const body = await response.text();
    expect(body).toContain("余额不足，请及时充值");
    expect(body).toContain("data: [DONE]");
  });

  it("auto-continues observed workbench status finals that mention summarizing later", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-observed-progress",
      message: "继续",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const initialSend = fakeWs.requests.find(
      (request) => request.method === "agent",
    );
    const runId = String(initialSend?.params.idempotencyKey);

    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-observed-progress",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "我重新从 OneDrive 桌面定位这个 PDF，并用可用工具把简历内容提取出来后总结。",
            },
          ],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const followupSend = fakeWs.requests
      .filter((request) => request.method === "agent")
      .find((request) => String(request.params.idempotencyKey) !== runId);
    expect(followupSend).toBeTruthy();
    expect(String(followupSend?.params.message)).toContain("立即调用 OpenClaw");

    const followupRunId = String(followupSend?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-observed-progress",
        runId: followupRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "总结如下：候选人经验..." }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("OneDrive 桌面定位");
    expect(body).toContain("总结如下：候选人经验...");
    expect(body).toContain("data: [DONE]");
  });

  it("auto-continues long progress finals instead of stopping after one status update", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-long-progress",
      message: "去桌面找简历并总结",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const initialSend = fakeWs.requests.find(
      (request) => request.method === "agent",
    );
    const runId = String(initialSend?.params.idempotencyKey);
    const longProgress =
      "正在桌面路径递归查找简历文件并等待搜索结果，这里先同步当前进度。".repeat(6);

    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-long-progress",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: longProgress }],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const followupSend = fakeWs.requests
      .filter((request) => request.method === "agent")
      .find((request) => String(request.params.idempotencyKey) !== runId);
    expect(followupSend).toBeTruthy();

    const followupRunId = String(followupSend?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-long-progress",
        runId: followupRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "总结如下：候选人经验..." }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("正在桌面路径递归查找简历文件");
    expect(body).toContain("总结如下：候选人经验...");
    expect(body).toContain("data: [DONE]");
  });

  it("retries empty finals without attachments and keeps one stream", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-empty-final-retry",
      message: "帮我在桌面找简历并总结",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const initialSend = fakeWs.requests.find(
      (request) => request.method === "agent",
    );
    const runId = String(initialSend?.params.idempotencyKey);

    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-empty-final-retry",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const retrySend = fakeWs.requests
      .filter((request) => request.method === "agent")
      .find((request) => String(request.params.idempotencyKey) !== runId);
    expect(retrySend).toBeTruthy();
    expect(String(retrySend?.params.message)).toContain(
      "上一轮没有产生可见回复",
    );

    const retryRunId = String(retrySend?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-empty-final-retry",
        runId: retryRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "总结如下：候选人经验..." }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("总结如下：候选人经验...");
    expect(body).toContain("data: [DONE]");
  });

  it("does not auto-continue concise completed workbench results", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "session-complete",
      message: "帮我总结桌面简历",
      modelId: "link/gpt-5.5",
      permissionMode: "full",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const runId = String(send?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:session-complete",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "总结如下：候选人经验..." }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("总结如下：候选人经验...");
    expect(
      fakeWs.requests.filter((request) => request.method === "agent"),
    ).toHaveLength(1);
  });

  it("saves non-image workbench attachments for the OpenClaw agent", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: "file-session",
      message: "分析这个文件",
      permissionMode: "full",
      attachments: [
        {
          name: "测试.txt",
          type: "text/plain",
          kind: "text",
          size: 5,
          dataUrl: "data:text/plain;base64,aGVsbG8=",
        },
      ],
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const message = String(send?.params.message);
    expect(message).toContain("工作台附件已保存到当前");
    expect(message).toContain("测试.txt");
    expect(message).toContain("已提取正文");
    expect(message).toContain("hello");

    const savedPath = message.match(/: ([^\n]+测试\.txt)/u)?.[1];
    expect(savedPath).toBeTruthy();
    expect(savedPath).toContain(path.join(".openclaw", "agents", "main"));
    await expect(readFile(savedPath ?? "", "utf8")).resolves.toBe("hello");
  });

  it("stores workbench uploads under a short path to avoid Windows path-length failures", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: `long-session-${"x".repeat(180)}`,
      message: "分析这个文件",
      permissionMode: "full",
      attachments: [
        {
          name: `${"very-long-upload-name-".repeat(8)}.txt`,
          type: "text/plain",
          kind: "text",
          size: 5,
          dataUrl: "data:text/plain;base64,aGVsbG8=",
        },
      ],
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const message = String(send?.params.message);
    const savedPath =
      message
        .split("\n")
        .find((line) => line.includes("(text, text/plain):"))
        ?.split(": ")
        .slice(1)
        .join(": ") ?? "";
    expect(savedPath).toBeTruthy();
    expect(savedPath).toContain(`${path.sep}wb${path.sep}`);
    expect(path.basename(savedPath).length).toBeLessThanOrEqual(64);
    await expect(readFile(savedPath, "utf8")).resolves.toBe("hello");
  });

  it("saves text attachments with data URL parameters for OpenClaw reads", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: "charset-file-session",
      message: "总结这个上传附件",
      permissionMode: "full",
      executionMode: "read_only",
      attachments: [
        {
          name: "notes.md",
          type: "text/markdown",
          kind: "text",
          size: 5,
          dataUrl: "data:text/markdown;charset=utf-8;base64,aGVsbG8=",
        },
      ],
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const message = String(send?.params.message);
    expect(message).toContain("notes.md");
    expect(message).toContain("必须优先使用下列附件内容或文件路径");
    expect(message).toContain("已提取正文");
    expect(message).toContain("hello");

    const savedPath = message.match(/: ([^\n]+notes\.md)/u)?.[1];
    expect(savedPath).toBeTruthy();
    await expect(readFile(savedPath ?? "", "utf8")).resolves.toBe("hello");
  });

  it("extracts upload text without invoking OpenClaw", async () => {
    const extracted = await service.extractAttachments({
      attachments: [
        {
          name: "guide.html",
          type: "text/html",
          kind: "text",
          size: 38,
          dataUrl:
            "data:text/html;base64,PGgxPkNsYXctUGk8L2gxPjxwPlVzZSB0aGUgd29ya2JlbmNoLjwvcD4=",
        },
      ],
    });

    expect(fakeWs.requests).toHaveLength(0);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      name: "guide.html",
      type: "text/html",
      kind: "text",
      extractStatus: "ok",
    });
    expect(extracted[0]?.extractedText).toContain("Claw-Pi");
    expect(extracted[0]?.extractedText).toContain("Use the workbench.");
  });

  it("extracts PDF attachment text before asking OpenClaw", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: "pdf-upload-session",
      message: "总结这个 PDF",
      permissionMode: "full",
      executionMode: "read_only",
      attachments: [
        {
          name: "resume.pdf",
          type: "application/pdf",
          kind: "file",
          size: 592,
          dataUrl:
            "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDEwMCA3MDAgVGQgKEhlbGxvIFBERiBSZXN1bWUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzM5IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA5CiUlRU9GCg==",
        },
      ],
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const message = String(send?.params.message);
    expect(message).toContain("resume.pdf");
    expect(message).toContain("已提取正文");
    expect(message).toContain("Hello PDF Resume");
  });

  it("injects extracted upload text without local paths in basic permission mode", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: "basic-upload-session",
      message: "总结这个上传附件",
      permissionMode: "basic",
      executionMode: "read_only",
      attachments: [
        {
          name: "resume.txt",
          type: "text/plain",
          kind: "text",
          size: 17,
          dataUrl: "data:text/plain;base64,Y2FuZGlkYXRlIHN1bW1hcnk=",
        },
      ],
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const message = String(send?.params.message);
    expect(message).toContain("工作台已接收上传附件");
    expect(message).toContain("基础权限下不要读取本机路径");
    expect(message).toContain("resume.txt");
    expect(message).toContain("candidate summary");
    expect(message).not.toContain(rootDir);
    expect(message).not.toContain(".openclaw");
    expect(message).not.toMatch(/: [A-Z]:\\/u);
  });

  it("retries empty finals for saved workbench attachments", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: "empty-attachment-session",
      message: "总结这个上传附件",
      permissionMode: "full",
      executionMode: "read_only",
      attachments: [
        {
          name: "resume.txt",
          type: "text/plain",
          kind: "text",
          size: 5,
          dataUrl: "data:text/plain;base64,aGVsbG8=",
        },
      ],
    });

    const initialSend = fakeWs.requests.find(
      (request) => request.method === "agent",
    );
    const runId = String(initialSend?.params.idempotencyKey);

    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:main:workbench:empty-attachment-session",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const retrySend = fakeWs.requests
      .filter((request) => request.method === "agent")
      .find((request) => String(request.params.idempotencyKey) !== runId);
    expect(retrySend).toBeTruthy();
    expect(String(retrySend?.params.message)).toContain(
      "上一轮没有产生可见回复",
    );
    expect(String(retrySend?.params.message)).toContain("resume.txt");
    expect(String(retrySend?.params.message)).toContain("已提取正文");
    expect(String(retrySend?.params.message)).toContain("hello");
    expect(String(retrySend?.params.message)).toContain("只读分析模式");

    const retryRunId = String(retrySend?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:main:workbench:empty-attachment-session",
        runId: retryRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "总结如下：hello" }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("总结如下：hello");
    expect(body).toContain("data: [DONE]");
  });

  it("saves image attachments as workbench file references for image-to-image", async () => {
    await service.createOpenAiCompatibleStream({
      agentId: "main",
      sessionId: "image-session",
      message: "generate from uploaded image",
      permissionMode: "full",
      attachments: [
        {
          name: "ref.png",
          type: "image/png",
          kind: "image",
          size: 5,
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
      ],
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const message = String(send?.params.message);
    expect(message).toContain("工作台附件已保存到当前");
    expect(message).toContain("image_generate.inputImages");
    expect(send?.params.attachments).toMatchObject([
      { type: "image", mimeType: "image/png", content: "aGVsbG8=" },
    ]);

    const savedPath = message.match(/\): ([^\n]+ref\.png)/u)?.[1];
    expect(savedPath).toBeTruthy();
    await expect(readFile(savedPath ?? "", "utf8")).resolves.toBe("hello");
  });

  it("streams generated image markdown from OpenClaw tool details", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "image-output-session",
      message: "generate image",
      permissionMode: "full",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const runId = String(send?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:image-output-session",
        runId,
        state: "delta",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "图片已生成。" }],
          details: {
            markdown:
              "![生成图片](http://127.0.0.1:50800/api/internal/desktop/generated-images/abc.png)",
          },
        },
      },
    });
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:image-output-session",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "[[reply_to_current]] generated." }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("generated-images/abc.png");
    expect(body).not.toContain("reply_to_current");
  });

  it("keeps image details when the tool event has no assistant text", async () => {
    const response = await service.createOpenAiCompatibleStream({
      agentId: "bot-1",
      sessionId: "image-details-only-session",
      message: "generate image",
      permissionMode: "full",
    });

    const send = fakeWs.requests.find((request) => request.method === "agent");
    const runId = String(send?.params.idempotencyKey);
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:image-details-only-session",
        runId,
        state: "tool",
        message: {
          role: "toolResult",
          details: {
            markdown:
              "![生成图片](http://127.0.0.1:50800/api/internal/desktop/generated-images/slow.png)",
          },
        },
      },
    });
    fakeWs.emit({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "agent:bot-1:workbench:image-details-only-session",
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成。" }],
        },
      },
    });

    const body = await response.text();
    expect(body).toContain("已完成。");
    expect(body).toContain("generated-images/slow.png");
  });
});
