# Claw-Pi 发货待办清单

> 目标：打包 → 刷 U 盘 → 批量发货 200 套
>
> 最后更新：2026-03-31

---

## 第一层：不做就发不出去

- [x] **首页视频/封面资源**
  视频已移除，改为静态海报图。Logo 已生成（`claw-pi-mascot-logo.png`），需拷贝到 `apps/web/public/claw-pi-alpha-poster.jpg`。

- [x] **跑通 `pnpm dist:win` Windows 打包**
  已跑通。产出 `claw-pi-setup-0.1.7-x64.exe`（247MB）。
  修复了 3 个 Windows 适配问题：目录清理卡死（改用 `rmdir /s /q`）、rename EPERM（加 cp+rm fallback）、buildVersion 格式（改为 `x.y.z.commitCount`）。
  注意：输出目录须设在项目树外（`NEXU_DESKTOP_RELEASE_DIR=C:\nexu-build-output`），否则 Cursor 文件监视会锁 `app.asar`。

- [x] **后端部署上线 (duen-server)**
  已部署到阿里云 VPS（PostgreSQL + PM2 + nginx + 自签证书 + DNS）。

- [ ] **桌面端 cloudUrl 确认**
  确保打包出来的客户端连接的是真实后端地址 `api.clawpi.app:9443`，而不是一个不存在的域名。检查 `apps/controller/src/services/desktop-local-service.ts` 中 `defaultCloudProfile` 的 `cloudUrl`。

- [ ] **首次端到端测试**
  走通完整用户路径：安装 exe → 激活码注册 → 拿到 API Key → 连微信 → AI 回复成功。

---

## 第二层：不做也能跑，但卖出去会出问题

- [x] **批量生成激活码**
  用 `duen-server/scripts/generate-redeem-codes.ts` 生成 200+ 套激活码，导入数据库。每个 U 盘分配一个唯一激活码。

- [ ] **U 盘内容结构**
  准备 U 盘根目录文件：

  ```
  U盘/
  ├── Claw-Pi-Setup-0.1.7-x64.exe   # Windows 安装包
  ├── 快速入门.pdf                    # 安装指南
  └── 激活码.txt                      # 该 U 盘对应的唯一激活码
  ```

- [ ] **快速入门文档**
  面向小白用户的图文安装指南，覆盖：插 U 盘 → 双击安装 → 启动 → 输入激活码 → 连接微信 → AI 上线。

- [ ] **管理后台前端**
  目前 `duen-server` 只有管理 API（`/admin/*`），没有 Web UI。管理 200 台设备和兑换码只能靠 curl/Postman。至少需要一个简单的 Web 管理面板。

---

## 第三层：锦上添花（规模化需要）

- [ ] **USB 批量刷写脚本**
  自动化：格式化 U 盘 → 拷贝安装包 → 写入唯一激活码到 U 盘。200 个手动拷也行，但 500+ 就应该自动化。

- [x] **自动更新通道**
  ~~`electron-updater` 的 `publish` 目前是空数组 `[]`。卖出去后如果要推送更新，需要配 update feed URL（比如 GitHub Releases 或自建 S3）。~~
  已配置 `generic` provider，指向 `https://api.clawpi.app:9443/updates`。

- [x] **Sentry 错误监控**
  DSN 已配置，主进程和渲染进程均已初始化 `Sentry.init()`，sourcemap 上传脚本就位。

- [ ] **Windows 代码签名证书**
  没有签名的话用户安装时 SmartScreen 会拦截报"未知发布者"。需购买 EV 代码签名证书（约 $200-400/年）。

---

## 已完成

- [x] Windows 图标 `build/icon.ico`
- [x] macOS 图标 `build/icon.icns`
- [x] 后端 Bug 修复：quota-sync 用户 Token 搜索关键词 `nc-` → 增加 `user-`
- [x] 后端 Bug 修复：管理统计遗漏 `redeem_code` 和 `initial_gift` 类型
- [x] 后端 Bug 修复：`activateUser` 流水补上 `user_id`
- [x] 后端 Bug 修复：`.env.example` 补全 `AUTH_TOKEN_SECRET` 等必需变量
- [x] 品牌清理：16 个文件 nexu → Claw-Pi（UI 文案、模板、组件、服务标签等）
- [x] 品牌清理：AI Agent 模板 SOUL.md / AGENTS.md / BOOTSTRAP.md / IDENTITY.md / TOOLS.md
- [x] 品牌清理：联系方式替换为 clawpi.app / <support@clawpi.app>
- [x] 品牌清理：GitHub 链接替换为 claw-pi/claw-pi
- [x] 品牌清理：SVG 资源重命名 `ip-nexu.svg` → `ip-claw-pi.svg`
- [x] 首页视频移除，改为静态海报图 `claw-pi-alpha-poster.jpg`
- [x] 后端部署上线（PostgreSQL + PM2 + nginx + 自签证书 + DNS）
- [x] Windows 打包 `pnpm dist:win` 跑通，产出 `claw-pi-setup-0.1.7-x64.exe`（247MB）

---

## 建议执行顺序

```
1. ~~跑通 pnpm dist:win~~（✅ 已完成）
2. 处理首页视频（去掉或放素材）
3. 部署后端到 VPS
4. 确认 cloudUrl + 端到端测试
5. 批量激活码 + U 盘内容 + 快速入门文档
6. 刷 U 盘 + 发货
```
