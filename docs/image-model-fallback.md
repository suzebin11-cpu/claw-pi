# 生图模型兜底策略

## 功能说明

当用户选择的生图模型出现上游服务问题时，系统会自动尝试使用更稳定的备用模型，确保用户能够顺利生成图片。

## 兜底链配置

目前仅针对 **OpenAI 系列模型** 配置了兜底链：

```
gpt-image-2 → gpt-image-1.5 → gpt-image-1-mini
gpt-image-1.5 → gpt-image-1-mini
gpt-image-1-mini → (无兜底，最稳定)
```

## 触发条件

**会触发兜底的情况**（上游服务问题）：
- HTTP 状态码：429（限流）、502/503/504（上游不可用）
- 超时错误
- 网络连接失败
- 上游明确表示繁忙或过载

**不会触发兜底的情况**（用户/内容问题）：
- 余额不足
- 安全审核拒绝（提示词违规）
- 参数错误

## 用户体验

### 成功兜底时的提示

**微信/桌面聊天**：
```
图片已生成（使用了备用模型 gpt-image-1.5，原模型 gpt-image-2 暂时繁忙）。
![生成图片](http://127.0.0.1:3010/api/internal/desktop/generated-images/xxx.png)
```

### 响应数据结构

成功兜底时，API 响应会包含以下额外字段：

```json
{
  "ok": true,
  "id": "uuid",
  "modelId": "clawpi-image/gpt-image-1.5",
  "url": "http://...",
  "markdown": "![...](...)",
  "fallbackUsed": true,
  "fallbackFrom": "clawpi-image/gpt-image-2",
  "fallbackTo": "clawpi-image/gpt-image-1.5"
}
```

## 行为特性

1. **透明性**：明确告知用户使用了备用模型
2. **一次性**：仅本次请求使用备用模型，下次请求仍使用用户选择的模型
3. **级联尝试**：如果第一个备用模型也失败，会继续尝试下一个
4. **日志记录**：所有兜底事件都会记录到日志，便于监控和分析

## 日志事件

### 尝试兜底
```
image_generation_attempting_fallback
{
  requestedModelId: "clawpi-image/gpt-image-2",
  fallbackChain: ["clawpi-image/gpt-image-1.5", "clawpi-image/gpt-image-1-mini"],
  errorMessage: "Service temporarily unavailable",
  errorStatus: 503
}
```

### 兜底成功
```
image_generation_fallback_success
{
  requestedModelId: "clawpi-image/gpt-image-2",
  fallbackModelId: "clawpi-image/gpt-image-1.5",
  durationMs: 5230
}
```

### 兜底失败
```
image_generation_all_fallbacks_failed
{
  requestedModelId: "clawpi-image/gpt-image-2",
  fallbackChain: ["clawpi-image/gpt-image-1.5", "clawpi-image/gpt-image-1-mini"]
}
```

## 未来扩展

可能的增强方向：

1. **跨提供商兜底**：为 Doubao、Qwen 等模型配置兜底链
2. **健康度监控**：基于历史成功率动态调整兜底策略
3. **用户配置**：允许用户开关兜底功能或自定义兜底链
4. **临时切换**：连续失败时临时切换默认模型（持续一段时间）

## 技术实现

**核心文件**：
- `apps/controller/src/services/image-generation-service.ts` - 兜底逻辑实现
- `apps/controller/static/runtime-plugins/clawpi-image-generation/index.js` - 用户提示
- `apps/controller/src/routes/image-generation-routes.ts` - API 响应结构

**测试文件**：
- `tests/desktop/image-generation-service.test.ts` - 单元测试

## 版本信息

- **引入版本**：v0.3.15
- **状态**：已实现，待测试
