# OpenClaw Agent Workbench Requirements

## Background

Claw-Pi currently has multiple user-facing conversation surfaces:

- WeChat / Feishu / QQ channels
- Web runtime entry, currently named "网页龙虾"
- Claw-Pi SaaS workbench entry, currently named "龙虾工作台"

The product expectation is that all of these surfaces are backed by OpenClaw agents. The model provider can still be the existing cloud relay / transit provider. OpenClaw should be responsible for agent execution: memory, skills, tools, local files, permissions, sessions, and result artifacts.

The current implementation is mixed:

- "网页龙虾" opens OpenClaw's `/chat` UI and is closer to the real OpenClaw agent runtime.
- "龙虾工作台" currently builds chat messages in the web app and sends them to the controller's OpenAI-compatible `/v1/chat/completions` route. That route proxies directly to the configured model provider. This path does not run a full OpenClaw agent turn.

This makes the workbench feel like a normal chat app instead of an agent product.

## Goal

Make "龙虾工作台" a first-class OpenClaw agent client while preserving the existing product behavior and keeping the current model relay configuration.

The desired final flow is:

```text
User surface
  -> Claw-Pi controller
  -> OpenClaw agent/session runtime
  -> configured model provider through cloud relay
  -> OpenClaw tools / memory / skills / file workspace
  -> Claw-Pi UI-rendered result
```

## Non-Goals

- Do not replace the cloud relay model provider.
- Do not remove the current OpenAI-compatible `/v1/chat/completions` route immediately.
- Do not expose raw OpenClaw tool output to end users.
- Do not bypass OpenClaw agent execution for workbench user replies.
- Do not make every normal short chat turn heavy if a lightweight response is enough.

## Current Findings

### Workbench Chat Path

`apps/web/src/pages/ask.tsx` builds a request payload and calls `/v1/chat/completions`.

`apps/controller/src/routes/misc-compat-routes.ts` receives that request, reads the current OpenClaw model config, then proxies the request to the configured OpenAI-compatible provider.

This uses OpenClaw's model configuration, but it does not execute an OpenClaw agent turn.

### Attachment Handling

The workbench currently reads:

- Images as data URLs
- Text-like files as text
- Other files as metadata only

PPT/PPTX, DOC/DOCX, XLS/XLSX, PDF, and videos are accepted by the picker, but most are not parsed into usable context. For example, a PPT is effectively sent as "Attached file: example.pptx", so the model cannot inspect slide contents.

### Local Action Handling

The workbench has a small local-action layer for:

- Open URL
- Open path
- Create folder
- Create text file
- Create spreadsheet

This is not the same as OpenClaw tool execution. It is a fixed frontend/controller action set, not a general agent tool loop.

### Skills

Installed skills are not currently active in the runtime state being tested. The runtime agent config has an empty `skills` list. The existing dynamic skill injection for `/v1/chat/completions` injects selected skill text, but does not provide full tool execution.

## Product Requirements

### P0: Preserve Existing Product Behavior

The existing chat, model selection, image generation, WeChat connection, and web runtime entry must keep working during migration.

Requirements:

- Keep the current `/v1/chat/completions` path available for legacy/diagnostic callers, but do not silently use it for 龙虾工作台 user replies.
- Add a feature flag or runtime config switch for the new OpenClaw-backed workbench path.
- Do not change WeChat/Feishu/QQ channel behavior unless explicitly required.
- Do not change default model routing semantics.
- Ensure model marketplace switching still updates the runtime model used by OpenClaw.

### P0: Workbench Uses OpenClaw for Agentic Tasks

When a user asks for tasks that require files, tools, local actions, memory, or skills, "龙虾工作台" must route the turn through OpenClaw agent execution.

Examples:

- "处理桌面上的这个 PPT"
- "帮我把这个 Excel 整理成汇总表"
- "读取这个文档并生成一份方案"
- "打开网页，查资料，然后整理成表格"
- "把这张图改成蓝色版本"
- "根据这个文件生成新文件"

### P0: File Context Must Be Real

Uploaded files must be available to the agent as real files, not just filename metadata.

Requirements:

- Save uploaded files into the active agent workspace or a controlled artifact directory.
- Pass stable local file references to the OpenClaw agent.
- Extract text/metadata for common document formats when useful.
- Make generated files accessible from the UI with preview, copy, open folder, and download controls.

Required formats for first usable release:

- PNG/JPG/WebP images
- TXT/MD/CSV/JSON/log/text
- PDF
- DOCX
- PPTX
- XLSX

Optional later:

- DOC/PPT/XLS legacy binary formats
- Videos with frame/audio extraction
- ZIP/project folders

### P0: Permission Levels

Workbench local capabilities must respect the product permission model.

Recommended levels:

- Basic: normal chat, uploaded file handling, image preview, web-safe actions. No arbitrary local file reads.
- Confirm: agent may propose local file/tool actions; user confirms before execution.
- Full: agent may execute allowed local actions without per-action confirmation.

Product default:

- New users should default to Full mode for the workbench. The product promise is that Claw-Pi can act like a real local assistant, not a passive chat box.
- Full mode must still be bounded. It means "execute allowed local assistant actions without repeated confirmation", not "unrestricted machine control".
- The UI should show a small persistent permission indicator so users can downgrade to Confirm or Basic, but should not force a setup dialog before first use.

Controls:

- Permission level is visible and changeable from the workbench.
- Dangerous operations still require guardrails even in Full mode.
- All local file access must stay inside allowed roots unless explicitly granted.
- Destructive operations should be blocked or require confirmation in all modes.

### P1: Unified Sessions

The workbench should have conversation windows similar to ChatGPT/Cherry Studio, but each window should map to an OpenClaw session where possible.

Requirements:

- Multiple workbench chats.
- Rename chats.
- Preserve history when switching pages.
- Show active/running/unread indicators.
- Avoid blocking one chat while another agent is replying.
- Store OpenClaw session identifiers so a chat can resume the correct agent context.

### P1: User-Friendly Tool Progress

Users should see useful progress, not raw internal tool output.

Examples:

- "正在读取 PPT..."
- "正在分析第 1-12 页..."
- "正在生成 Excel..."
- "已完成，文件已生成"

Requirements:

- Hide raw tool prompts and internal instructions.
- Collapse technical logs by default.
- Surface errors in user language with a recovery suggestion.

### P1: Keep Fast Path for Simple Chat

The product should not feel slower for simple chat.

Recommended behavior:

- Simple short chat can still use a lightweight OpenClaw agent turn.
- If that is too slow, keep the existing direct model path behind a compatibility switch.
- Agentic tasks always use OpenClaw.
- Track latency separately for direct model path vs OpenClaw path.

### P1: Skills Are Lazy and Relevant

Skills should improve capability without adding large startup overhead.

Requirements:

- Keep a lightweight skill index available.
- Only inject/read full skill details when the user request matches.
- Make installed skills visible in the UI.
- Avoid loading all skills into every prompt.

## Recommended Architecture

### Phase 1: Add an OpenClaw Agent Bridge

Add a controller-owned abstraction:

```text
AgentChatService
  sendMessage(input)
  streamEvents(input)
  attachFiles(input)
  getSession(input)
```

This service should hide the concrete OpenClaw gateway details from the web UI.

The web app should not directly call OpenClaw gateway internals. It should call Claw-Pi controller APIs.

Suggested APIs:

- `POST /api/internal/agent-chat/sessions`
- `POST /api/internal/agent-chat/sessions/:id/messages`
- `GET /api/internal/agent-chat/sessions/:id/events`
- `POST /api/internal/agent-chat/attachments`
- `GET /api/internal/agent-chat/artifacts/:id`

### Phase 2: Route Workbench Replies Through OpenClaw

Keep the existing workbench UI, but route workbench user replies through OpenClaw:

```text
use AgentChatService / OpenClaw
```

The existing direct model route remains available for non-workbench compatibility and diagnostics only. It must not be a silent fallback for normal workbench replies, because that would remove OpenClaw execution rights.

### Phase 3: Make Workbench Fully OpenClaw-Backed

After Phase 2 is stable:

- Move normal workbench chat to the OpenClaw agent path.
- Keep direct `/v1/chat/completions` only for diagnostics/fallback.
- Align workbench sessions with OpenClaw sessions.
- Make model switching, image generation, skills, and file artifacts all use the same OpenClaw-backed state.

## Compatibility Strategy

### Feature Flags

Add runtime switches:

- `workbench.agentRuntime.enabled`
- `workbench.agentRuntime.routeAgenticTasksOnly`
- `workbench.agentRuntime.fallbackToCompatChat`
- `workbench.agentRuntime.fileTools.enabled`

Default for first release:

```json
{
  "workbench": {
    "agentRuntime": {
      "enabled": true,
      "routeAgenticTasksOnly": false,
      "fallbackToCompatChat": false,
      "defaultPermissionMode": "full",
      "fileTools": {
        "enabled": true
      }
    }
  }
}
```

Then enable in dev/manual test builds first.

When `workbench.agentRuntime.enabled` is enabled for production, the default permission mode should remain `full`. The feature flag controls whether the new OpenClaw-backed workbench path is active; it should not silently downgrade the intended product permission model.

### Fallback Behavior

If OpenClaw agent execution fails:

- For 龙虾工作台 user replies: show a clear error and do not silently fall back to direct model chat.
- For legacy/diagnostic callers that intentionally use `/v1/chat/completions`: keep the existing behavior.
- For file/local/tool tasks: show a clear error and do not silently pretend the task was completed.

### Existing Entry Points

Do not change initially:

- WeChat channel message handling
- Feishu channel message handling
- QQ channel message handling
- "网页龙虾" OpenClaw `/chat` link
- Model marketplace write path

## Risks and Mitigations

### Risk: Reply Speed Gets Slower

Cause:

- OpenClaw injects context, checks tools, may read files/skills.

Mitigation:

- Start with agentic-task routing only.
- Keep direct chat fallback.
- Keep skills lazy.
- Add timing logs per phase: enqueue, first token, tool start/end, final output.

### Risk: Local File Permissions Become Too Broad

Cause:

- Agent runtime can access more of the user's machine.

Mitigation:

- Default Full mode for user experience, but keep a strict allow/deny policy under it.
- Allow common local assistant actions without confirmation: read uploaded files, create files in Desktop/Documents/Downloads, open URLs, create folders, generate Office-style outputs.
- Require confirmation even in Full mode for high-risk actions: deleting files, overwriting existing files, moving large folders, running arbitrary shell commands, reading sensitive paths, sending data to external services beyond the configured model provider.
- Require confirmation for local file reads outside common user roots unless the user explicitly gives a file/folder path in the current task.
- Restrict allowed roots.
- Log local file actions.
- Block destructive actions by default.

### Risk: UI Shows Internal OpenClaw Output

Cause:

- OpenClaw tool events may include raw prompts, paths, logs, or implementation details.

Mitigation:

- Add event normalization in controller.
- Only send display-safe event types to web UI.
- Keep raw events in logs only.

### Risk: Session State Diverges

Cause:

- Workbench sessions and OpenClaw sessions may not map 1:1.

Mitigation:

- Store `openclawSessionKey` in workbench session metadata.
- Do not infer session identity from title.
- Add migration fallback for old localStorage-only sessions.

### Risk: Existing Web/WeChat Behavior Breaks

Cause:

- Changing shared model config or OpenClaw runtime config can affect channels.

Mitigation:

- Keep config compiler behavior unchanged in Phase 1.
- Add new controller routes rather than replacing existing ones.
- Test WeChat, 网页龙虾, 龙虾工作台, model switch, image generation after each phase.

## Acceptance Criteria

### Phase 1 Technical Validation

- A controller test or manual dev script can send one message to the default OpenClaw agent and receive a reply.
- The reply uses the currently selected model from model marketplace.
- A created OpenClaw session can be resumed.
- Existing `/v1/chat/completions` still works.

### Phase 2 Product Validation

- User uploads a PPTX in 龙虾工作台 and asks for summary; the agent sees actual slide content or extracted content.
- User asks to create a file on Desktop; permission mode controls whether it runs immediately, asks, or refuses.
- User can continue using simple chat without noticeable regression.
- Existing WeChat and 网页龙虾 replies still work.
- Image generation still returns previewable/downloadable images.

### Phase 3 Product Validation

- All workbench conversations are OpenClaw-backed.
- Multiple chat windows can run independently.
- Model switching in model marketplace affects workbench, 网页龙虾, and channels consistently.
- Skills can be installed and used lazily without large startup slowdown.
- Tool progress is user-friendly and raw tool output is hidden.

## Implementation Plan

### Step 1: Confirm OpenClaw Programmatic Entry

Find the most stable way to send a message into OpenClaw without using the embedded `/chat` UI directly.

Preferred order:

1. Official/local gateway API for sessions/message send.
2. Existing WebSocket operator channel if it supports session send.
3. Controlled adapter around OpenClaw webchat endpoint.
4. Last resort: keep `/chat` as iframe/webview and communicate through a bridge.

Do not start product migration until this is verified.

### Step 2: Add Controller AgentChatService

Create a controller layer that:

- Resolves active agent ID.
- Creates/resumes OpenClaw session.
- Sends user message.
- Streams normalized events.
- Maps artifacts and files to Claw-Pi UI objects.

### Step 3: Add File Attachment Pipeline

Add controller storage for workbench attachments:

- Save uploaded files safely.
- Associate them with workbench session and OpenClaw workspace.
- Extract common document content.
- Pass both file path and extracted context to the agent.

### Step 4: Add Workbench Routing

In `AskPage`:

- Keep current chat path.
- Add agentic-task detection.
- If enabled and matched, call `AgentChatService`.
- Render normalized OpenClaw events.
- Fallback only when safe.

### Step 5: Expand Test Coverage

Tests should cover:

- Route selection.
- Permission decisions.
- Attachment persistence.
- Document extraction failures.
- Fallback path.
- Model switch consistency.
- Session resume.

## Open Questions

- Which OpenClaw gateway API is stable enough for programmatic webchat send?
- Should uploaded user files be copied into the agent workspace or referenced from a controller artifact store?
- How much desktop file access should "Full" mode allow by default?
- Should all workbench sessions use the same default agent, or should users be able to create one agent per chat?
- Should "网页龙虾" remain as an advanced/raw OpenClaw UI, or eventually be replaced by the Claw-Pi workbench UI?

## Recommendation

Use a staged migration.

Do not replace the current workbench chat path in one step. First add a new OpenClaw agent bridge and route only file/tool/complex tasks through it. After that path is stable, migrate ordinary chat to OpenClaw-backed sessions.

This preserves current product behavior while moving the product toward the intended architecture: every visible assistant is an OpenClaw agent, with models supplied by the existing cloud relay.
