# 修复：生图成功但显示"没有收到有效回复"

## 问题总结

**症状**：
- 用户使用 gpt-image-1.5 生图
- API 调用成功，已扣费
- 图片生成成功
- 但龙虾工作台聊天页面显示"没有收到有效回复，请重试"

**根本原因**：
OpenClaw 在某些情况下调用 `image_generate` 工具成功后，没有在 `final` 消息的文本部分包含生成的图片 markdown 链接。这导致 `agent-chat-service` 认为收到了空回复，触发自动重试机制，重试耗尽后显示错误提示。

## 修复方案

### 修改文件
- `apps/controller/src/services/agent-chat-service.ts`
- `apps/controller/src/services/image-generation-service.ts`
- `tests/desktop/image-generation-service.test.ts`

### 核心修复：空回复特殊处理

在 `agent-chat-service.ts` 的 `state === "final"` 处理中，当检测到文本为空时，先尝试从 payload 中提取生图工具的结果：

```typescript
if (state === "final") {
  writeText(messageText);
  if (!lastText) {
    // 新增：特殊处理生图工具结果
    const imageMarkdown = extractGeneratedImageText(
      isObject(payload.message) ? payload.message : {},
    );
    if (imageMarkdown) {
      writeText(imageMarkdown);
      logger.info(
        { /* ... */ },
        "agent_chat_image_fallback_extracted",
      );
      finish();
      return;
    }
    
    // 原有逻辑：自动重试
    if (autoContinueTurns < AGENT_CHAT_AUTO_CONTINUE_MAX_TURNS) {
      // ...
    }
  }
}
```

**工作原理**：
1. 检测到 final 消息文本为空
2. 调用 `extractGeneratedImageText` 从 payload 的 `message` 对象中提取图片链接
3. 该函数会检查 `details.markdown`、`details.mediaUrl`、`details.media` 等字段
4. 如果找到有效的图片 URL，将其作为文本输出
5. 记录日志事件 `agent_chat_image_fallback_extracted`
6. 完成流程，不触发错误提示

### 辅助修复：兜底策略完善

同时修复了生图模型兜底策略的问题：

1. **创建自定义错误类**：`ImageGenerationError` 携带 HTTP 状态码
2. **保留状态码信息**：在重试和兜底逻辑中正确传递状态码
3. **修正测试用例**：确保兜底策略的测试能够正确验证

## 验证

### 单元测试
```bash
npm test -- tests/desktop/image-generation-service.test.ts
```

✅ 所有 6 个测试通过：
- 基本生图功能
- 兜底策略（503 → gpt-image-1.5）
- 不兜底场景（余额不足、安全拒绝）

### 模型健康诊断
```bash
node scripts/diagnose-image-models.mjs
```

✅ 所有 OpenAI 模型可用：
- GPT Image 2: 22.52s
- GPT Image 1.5: 33.31s
- GPT Image 1 Mini: 32.40s

## 影响范围

### 受益场景
1. **OpenClaw 未输出图片链接**：工具调用成功但 final 文本为空
2. **格式不匹配**：图片链接存在但不在文本中，而在 details 中
3. **异步工具调用**：工具执行完成但结果未及时同步到文本流

### 不影响场景
1. **正常流程**：OpenClaw 正确输出图片链接，直接显示
2. **真实错误**：API 调用失败，正确显示错误信息
3. **其他工具**：不影响文件、网页等其他工具的处理

## 日志事件

### 新增日志
- `agent_chat_image_fallback_extracted`：成功从 payload 提取图片链接

### 现有日志（生图相关）
- `image_generation_completed`：图片生成成功
- `image_generation_fallback_success`：使用兜底模型成功
- `image_generation_attempting_fallback`：尝试兜底
- `agent_chat_empty_final_exhausted`：空回复重试耗尽（现在不应再触发）

## 后续优化建议

### 短期
1. **监控新日志事件**：统计 `agent_chat_image_fallback_extracted` 的触发频率
2. **OpenClaw Prompt 增强**：更明确地要求输出图片 markdown
3. **前端容错**：即使无文本，也展示工具副作用（图片、文件）

### 长期
1. **结构化工具返回**：将生图结果作为独立消息块，不依赖文本输出
2. **流式工具结果**：工具执行完成后立即推送到前端
3. **多模态消息**：支持文本 + 图片 + 文件的复合消息结构

## 相关文档
- [生图模型兜底策略](./image-model-fallback.md)
- [问题详细分析](./image-generation-issue-analysis.md)
- [诊断脚本](../scripts/diagnose-image-models.mjs)

## 版本信息
- **修复版本**：v0.3.15
- **修复日期**：2026-07-14
- **相关 Issue**：生图成功但前端显示"没有收到有效回复"
