# OpenClaw U 盘产品 — 功能对标 & 实施方案

> 对标友商产品功能，梳理差距、优先级和实施方案。
>
> 最后更新：2026-04-04

## 状态总览


| #   | 功能                           | 当前状态              | 优先级 | 工作量 |
| --- | ---------------------------- | ----------------- | --- | --- |
| 1   | U 盘插入自动跳转 Web UI             | 可做（受 OS 限制）       | P1  | 小   |
| 2   | Web UI 内直接问答 + OpenClaw 控制面板 | 部分有（只读历史）         | P0  | 中   |
| 3   | 执行权：生成 HTML 网站 / PDF         | 部分有（MD/PDF skill） | P1  | 小~中 |
| 4   | 避免桌面文件闪烁 / 文件被移动             | 未涉及               | P2  | 小   |
| 5   | 内置 skill 包                   | ✅ 已实现             | —   | —   |
| 6   | UI：运行日志 + 联系客服               | 客服已有，日志未实现        | P1  | 中   |
| 7   | 客户端首页中文                      | ✅ 已实现             | —   | —   |


---

## 1. U 盘插入自动跳转 Web UI

### 现状

无任何 autorun 机制。便携版已支持从 U 盘双击 exe 启动。

### 限制

Windows 10+ 默认禁用 `autorun.inf` 的自动执行（安全策略），无法做到插入即自动运行 exe。

### 方案

1. 在 U 盘根目录放置 `autorun.inf`，配置自定义图标和卷标，让 U 盘在资源管理器中显示品牌图标和名称：

```ini
[autorun]
icon=Claw-Pi\resources\icon.ico
label=OpenClaw
open=Claw-Pi\Claw-Pi.exe
```

1. 在 U 盘根目录放一个醒目的 `启动 OpenClaw.bat`，内容为：

```batch
@echo off
start "" "%~dp0Claw-Pi\Claw-Pi.exe"
```

1. 利用 Windows 插入 U 盘时弹出的通知/自动播放提示，引导用户点击打开文件夹后双击启动。

### 交付物

- `autorun.inf`
- `启动 OpenClaw.bat`
- 打包脚本自动生成这两个文件到输出目录

---

## 2. Web UI 内直接问答 + OpenClaw 控制面板

### 现状

- `sessions.tsx` 有聊天历史查看器（`ChatBubble`、`ChatMarkdown`），但只读，无输入框。
- OpenClaw Dashboard 通过新标签页跳转到 `127.0.0.1:18789`，未内嵌。

### 方案

**阶段一：内嵌对话输入（核心）**

在 sessions 页面底部增加消息输入组件：

- 新增 `ChatComposer` 组件，包含文本输入框和发送按钮
- 调用 OpenClaw API（`POST /api/v1/chat/completions` 或对应的 agent 消息接口）发送消息
- 消息发送后实时追加到聊天历史列表
- Controller 侧新增一个代理路由，将消息转发给 OpenClaw runtime

**阶段二：内嵌 OpenClaw 控制面板**

- 在 Web UI 中新增一个"控制面板"页面
- 通过 iframe 嵌入 OpenClaw Dashboard（`http://127.0.0.1:18789`）
- 或者提取关键操作（启动/停止 runtime、查看状态）做成原生组件

### 涉及文件

- `apps/web/src/pages/sessions.tsx` — 增加 ChatComposer
- `apps/web/src/components/chat/` — 新增 chat-composer 组件
- `apps/controller/src/routes/` — 新增消息代理路由
- `apps/web/src/pages/` — 新增控制面板页面（阶段二）

---

## 3. 执行权：生成 HTML 网站 / PDF

### 现状

- `deep-research` skill 能生成 Markdown 研究报告
- `research-to-diagram` skill 有 PDF 生成能力（Graphviz DOT → PDF）
- 无"生成漂亮 HTML 页面"的 skill

### 方案

**新增 `html-report` skill：**

- 接收用户指令（如"帮我做一个 5 天的宜宾旅游规划"）
- 让模型生成完整的单文件 HTML（内联 CSS，包含排版和样式）
- 输出到 OpenClaw workspace 的 `output/` 目录
- 生成完成后自动调用系统默认浏览器打开 HTML 文件

**Skill 模板要点：**

- Prompt 中明确要求模型输出完整 HTML，包含 `<style>` 标签内的美化样式
- 指定响应式布局、中文字体
- 可选：skill 内置一个 HTML 模板骨架，模型只填充内容部分

**PDF 增强（可选）：**

- 利用 Electron 内置的 `printToPDF` API 将生成的 HTML 转为 PDF
- 或在 controller 侧用 Puppeteer/Playwright 做 HTML → PDF 转换

### 涉及文件

- `apps/desktop/static/bundled-skills/html-report/` — 新 skill 目录
- `apps/controller/src/services/skillhub/curated-skills.ts` — 注册为默认 skill

---

## 4. 避免桌面文件闪烁 / 文件被移动

### 现状

未做任何处理。Agent 执行文件操作时如果目标是桌面等用户可见目录，Windows 资源管理器会实时刷新导致闪烁。

### 方案

**隔离工作目录策略：**

1. OpenClaw workspace 配置中设置默认工作目录为 `data/workspace/`（便携版路径在 U 盘上）
2. Agent 所有文件操作在此隔离目录中进行
3. 任务完成后，通过 skill 将最终产物（HTML/PDF/文档）一次性复制到用户指定位置，或直接在 Web UI 中提供下载/预览链接
4. 避免 Agent 直接操作桌面路径

### 涉及文件

- `apps/controller/src/lib/openclaw-config-compiler.ts` — workspace 路径配置
- 新增 skill 或 skill 模板中约束输出路径

---

## 5. 内置 skill 包

### 现状：✅ 已实现

- 打包内置 9 个 skill：`coding-agent`、`deep-research`、`research-to-diagram`、`nano-banana-one-shop`、`clawhub`、`gh-issues` 等
- 首次启动自动安装 10 个 curated skill：`healthcheck`、`multi-search-engine`、`file-organizer-skill`、`find-skill` 等
- 8 个飞书专用 skill：日历、文档、任务、表格等
- SkillHub 服务完整，支持浏览、安装、卸载

### 待优化

- 将第 3 项中新增的 `html-report` skill 加入默认 bundle
- 根据 U 盘产品定位，精选最适合目标用户的 skill 组合

---

## 6. UI：运行日志 + 联系客服

### 现状

- **联系客服**：已有，帮助菜单中有文档链接和 `hi@clawpi.app` 邮件链接
- **运行日志**：未实现，日志只存在于文件系统（`data/logs/`）

### 方案

**运行日志查看器：**

1. Controller 新增日志读取 API：
  - `GET /api/runtime/logs` — 返回最近 N 行日志
  - 支持 `tail` 模式（SSE 或 WebSocket 实时推送）
2. Web UI 新增"运行日志"页面：
  - 日志列表，支持按时间倒序查看
  - 实时滚动，类似终端输出
  - 日志级别筛选（info / warn / error）
  - 放在设置或侧栏的"高级"区域

**联系客服增强：**

- 帮助菜单中增加微信客服二维码弹窗
- 增加"反馈问题"入口，可一键导出诊断信息（版本号、日志摘要、系统信息）

### 涉及文件

- `apps/controller/src/routes/` — 新增 runtime-logs 路由
- `apps/web/src/pages/` — 新增 logs 页面
- `apps/web/src/layouts/workspace-layout.tsx` — 增强帮助菜单

---

## 7. 客户端首页中文

### 现状：✅ 已实现

- i18n 框架已搭好（`i18next` + `react-i18next`）
- 支持 `en` 和 `zh-CN` 两种语言
- 有语言切换器（"中文" / "EN"）
- Skill 名称和描述有独立的中文翻译文件

### 待确认

- 默认语言是否跟随系统语言自动切换（如果用户系统是中文，首页应默认中文）
- 是否有遗漏未翻译的 UI 文案

---

## 实施优先级建议

### 第一批（核心体验，1-2 周）

1. **#2 Web UI 问答**（阶段一：ChatComposer） — 这是用户最直接感知的功能差距
2. **#1 U 盘自动启动引导** — 配合便携版，提升开箱体验

### 第二批（产品增强，1 周）

1. **#3 HTML 报告生成 skill** — 展示 Agent 执行力的最佳方式
2. **#6 运行日志查看器** — 提升可观测性和专业感

### 第三批（体验打磨）

1. **#4 文件操作隔离** — 解决稳定性问题
2. **#6 联系客服增强** — 微信二维码等

