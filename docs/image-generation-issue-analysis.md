# 生图"没有收到有效回复"问题分析

## 问题描述

**现象**：
- 用户在龙虾工作台聊天页面使用 image1.5 生图
- 实际扣费成功（说明API调用成功）
- 窗口聊天记录里有生图记录
- 但前端显示"没有收到有效回复，请重试"

**矛盾点**：API成功返回 + 扣费成功 + 但前端提示失败

## 根本原因

### 问题定位：`agent-chat-service.ts:1130-1224`

**触发条件**：
```typescript
if (state === "final") {
  writeText(messageText);
  if (!lastText) {  // ← 关键：messageText 为空
    if (autoContinueTurns < AGENT_CHAT_AUTO_CONTINUE_MAX_TURNS) {
      // 尝试自动重试...
    } else {
      // 重试次数耗尽
      writeText("没有收到有效回复，请重试。");  // ← 这里显示错误
    }
  }
}
```

**核心问题**：当 OpenClaw 返回的 `final` 消息文本为空或被过滤掉时，系统认为没有收到有效回复。

### 场景分析

#### 正常流程
1. 用户：请生成一张图片
2. OpenClaw 调用 `image_generate` 工具
3. Controller API 成功生成图片（扣费）
4. 工具返回结果包含 `markdown: "![生成图片](http://...)"` 和 `details`
5. OpenClaw 的 `final` 消息应该包含图片链接
6. 前端渲染图片 ✅

#### 问题流程（实际发生的）
1. 用户：请生成一张图片
2. OpenClaw 调用 `image_generate` 工具
3. Controller API 成功生成图片（扣费）
4. 工具返回结果包含完整数据
5. **OpenClaw 的 `final` 消息为空或仅包含元数据标记**
6. `agent-chat-service` 检测到 `!lastText`
7. 触发自动重试机制
8. 重试次数耗尽后显示"没有收到有效回复" ❌

### 为什么会出现空的 final 消息？

#### 可能原因1：OpenClaw 没有在 final 回复中包含图片链接

**Runtime Plugin 的期望**（`clawpi-image-generation/index.js:6-7`）：
```javascript
const IMAGE_TOOL_PROMPT =
  "Use image_generate for image generation and image editing requests. ... 
   After a successful tool call, include the generated image markdown from 
   the tool result in web/workbench final replies so the client can render 
   the image.";
```

**实际情况**：OpenClaw 可能：
- 只调用了工具但没有在 final 回复中输出图片 markdown
- 或者输出了但被某些过滤逻辑移除了

#### 可能原因2：cleanAssistantText 过滤

```typescript
function cleanAssistantText(text: string): string {
  return text.replace(
    /\[\[(?:reply_to_current|_current_to_reply)\]\]\s*/giu,
    "",
  );
}
```

如果 OpenClaw 输出了特殊标记但没有实际内容，清理后变成空字符串。

#### 可能原因3：extractMessageText 提取失败

`extractMessageText` 负责从工具结果中提取文本和图片链接（`agent-chat-service.ts:539-560`）：

```typescript
function extractGeneratedImageText(value: Record<string, unknown>): string {
  const markdown =
    typeof value.markdown === "string" ? value.markdown.trim() : "";
  if (markdown && GENERATED_IMAGE_URL_PATTERN.test(markdown)) {
    return markdown;  // ← 期望匹配这个模式
  }
  
  const mediaUrl = /* ... 尝试从多个字段提取 ... */
  if (mediaUrl && GENERATED_IMAGE_URL_PATTERN.test(mediaUrl)) {
    return `![生成图片](${mediaUrl})`;
  }
  
  return "";  // ← 如果都不匹配，返回空字符串
}
```

**关键正则**：
```typescript
const GENERATED_IMAGE_URL_PATTERN =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif)/iu;
```

**可能问题**：
- 工具返回的 URL 格式与正则不匹配（例如端口不同、路径变化）
- `markdown` 字段缺失或格式不对
- `details` 结构与预期不符

## 复现路径

1. OpenClaw 调用 `image_generate` 工具成功
2. 工具返回数据结构正常（有 url、markdown、details）
3. **但 OpenClaw 在 final 回复中没有输出图片链接**
4. 或者输出了但格式不匹配 `GENERATED_IMAGE_URL_PATTERN`
5. `extractMessageText` 返回空字符串
6. `messageText` 为空，触发 `!lastText` 条件
7. 自动重试3次，每次都一样
8. 最终显示"没有收到有效回复"

## 验证方法

### 1. 检查日志事件

查找以下日志：
```
agent_chat_empty_final_retry_start
agent_chat_empty_final_retry_sent
agent_chat_empty_final_exhausted  ← 表示触发了这个问题
```

### 2. 检查 OpenClaw 实际返回

在 `handleChatEvent` 中添加日志，查看 `state === "final"` 时的 `payload.message` 完整内容。

### 3. 检查 URL 格式匹配

确认生成的图片 URL 是否匹配正则表达式。

## 解决方案

### 方案1：增强 extractGeneratedImageText（推荐）

放宽 URL 匹配规则，支持更多格式：

```typescript
const GENERATED_IMAGE_URL_PATTERN =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d+\/api\/internal\/desktop\/generated-images\/[A-Za-z0-9._~-]+\.(?:png|jpe?g|webp|gif)/iu;
```

### 方案2：改进空回复检测逻辑

在判断 `!lastText` 之前，检查是否有工具调用成功：

```typescript
if (state === "final") {
  writeText(messageText);
  if (!lastText) {
    // 检查是否有生图工具调用成功
    if (toolActivitySeen && hasImageGenerationActivity) {
      // 虽然文本为空，但工具调用成功，不算错误
      finish();
      return;
    }
    // ... 原有的重试逻辑
  }
}
```

### 方案3：增强工具返回处理

确保工具返回时自动注入到消息流：

```typescript
// 在 image_generate 工具返回后
if (data.ok && data.markdown) {
  // 直接将图片 markdown 作为消息写入
  writeText(data.markdown);
}
```

### 方案4：改进 OpenClaw Prompt

强化 system prompt，确保 OpenClaw 在 final 回复中包含图片：

```javascript
const IMAGE_TOOL_PROMPT =
  "Use image_generate for image generation requests. IMPORTANT: After calling 
   image_generate successfully, YOU MUST include the exact markdown string from 
   tool result's 'markdown' field in your final reply. Do not just describe the 
   image, output the markdown: ![生成图片](http://...). This is required for 
   the client to display the image.";
```

## 短期修复（最小改动）

在 `agent-chat-service.ts` 的空回复检测中添加特殊处理：

```typescript
if (state === "final") {
  writeText(messageText);
  if (!lastText) {
    // 特殊处理：检查工具返回的 details 中是否有生图结果
    const imageMarkdown = extractGeneratedImageText(payload.message);
    if (imageMarkdown) {
      writeText(imageMarkdown);  // 补充输出图片链接
      finish();
      return;
    }
    
    // 原有的重试逻辑...
    if (autoContinueTurns < AGENT_CHAT_AUTO_CONTINUE_MAX_TURNS) {
      // ...
    }
  }
}
```

## 长期改进

1. **结构化工具返回**：将生图结果作为独立的消息块，不依赖 OpenClaw 的文本输出
2. **增强遥测**：记录工具调用成功但 final 为空的情况
3. **前端容错**：即使文本为空，也展示工具调用的副作用（图片、文件等）
4. **提示词优化**：通过更强的约束确保 OpenClaw 输出格式正确

## 相关文件

- `apps/controller/src/services/agent-chat-service.ts:1130-1224` - 空回复检测逻辑
- `apps/controller/src/services/agent-chat-service.ts:539-560` - 图片链接提取
- `apps/controller/static/runtime-plugins/clawpi-image-generation/index.js` - 工具实现
- `apps/controller/src/services/image-generation-service.ts` - API层
