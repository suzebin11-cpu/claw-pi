# Claw-Pi Windows 桌面版发布

当前生产发布以 Windows x64 为默认目标。macOS 只在手动触发
`Desktop Release` 且关闭 `windows_only` 时构建；Apple 签名问题不会阻断
Windows OTA。

## 唯一源码真相

- 本地开发分支承载待发布改动。
- 一键发布命令先完成本地健康检查，再提交并强制推送当前分支。
- 远程 GitHub 仓库中的提交和指向该提交的不可变 `v{version}` 标签，是构建与发布的唯一源码真相。
- GitHub Actions 必须从标签检出源码，服务器不接受手工覆盖 Electron 源码。
- 当前本地 `main` 与 `origin/main` 历史尚未安全对齐，禁止从本地 `main` 发布。后续完成历史整理后，可恢复 `main` 版本变更自动打标签的常规路径。

远程仓库：

```text
https://github.com/suzebin11-cpu/claw-pi.git
```

## 一键发布

在仓库根目录运行：

```powershell
pnpm release:desktop -- --version=0.3.22
```

也可以使用默认补丁版本：

```powershell
pnpm release:desktop
```

命令依次执行：

1. 拉取远程引用并验证 GitHub CLI 登录。
2. 拒绝 detached HEAD、本地 `main`、已跟踪的 `.env` 和已存在的远程标签。
3. 运行 `pnpm release:desktop:check`，包括类型检查、Windows 发布相关根目录测试、Controller 测试、构建和 ESM 引用检查。该门禁排除 `data-directory-runtime.test.ts`、`lifecycle-teardown.test.ts`、全部 `*launchd*.test.ts`、全部 `*plist*.test.ts` 和 `entitlements-plist.test.ts` 这些依赖 macOS launchd、Apple plist 或 POSIX 路径语义的专属测试；不改变日常 `pnpm test` 的完整测试范围。
4. 健康检查通过后更新 `apps/desktop/package.json` 版本。
5. 检查空白错误，暂存全部当前源码改动并创建中文发布提交。
6. 使用 `git push --force` 推送当前开发分支。
7. 创建并推送不可变版本标签。
8. 等待 `desktop-release.yml` 完成。
9. 验证 GitHub Release 已发布、Windows 必需资产齐全，并验证两个公网 OTA 更新源。

如提交或分支推送中断，可用相同的显式版本重新运行命令。脚本允许当前包版本与
`--version` 相同，并会复用指向当前提交但尚未推送的本地标签。远程标签一旦存在
就不可覆盖。

`--skip-checks` 仅用于已经完整执行同一套检查的恢复场景。`--no-wait` 会在推送标签后返回，不代表发布已经成功。

## CI 发布顺序

标签触发 `Desktop Release` 后：

1. `source-health` 从不可变标签检出源码，再执行 Windows 发布健康检查；macOS launchd 专属测试不阻断 Windows 标签发布。
2. Windows runner 构建 NSIS x64 安装包并校验清单、SHA-512、文件大小、blockmap 和 SHA-256。
3. 安装包、blockmap、校验文件先上传到两个 R2 前缀。
4. 两个前缀的不可变文件都成功后，最后上传各自的 `latest.yml`。
5. CI 从公网地址反向验证目标版本和全部必需对象。
6. 只有公网验证成功，GitHub Release 才从草稿变为正式发布。

Windows 更新源：

```text
https://api.clawpi.app:9443/updates/stable/win/x64
https://api.clawpi.app:9443/updates/stable/x64
```

第二个地址用于兼容早期 Windows 客户端。服务端更新域名通过 Nginx 跳转到
Cloudflare R2；服务端不构建 Electron，也不直接修改客户端源码。

## 客户端行为

- 正式 NSIS 安装版启动后立即检查更新，此后每 15 分钟检查一次。
- 更新在后台下载，用户可以立即重启安装，也可在应用正常退出时安装。
- 更新后沿用用户数据目录，并重新执行登录状态、模型目录、OpenClaw 配置和 Gateway 恢复流程。
- portable 构建不参与自动更新。

## 回滚

优先发布修复后的更高版本。必须回滚更新源时，先恢复上一版本安装包、blockmap
和校验文件，最后恢复两个 Windows 前缀的上一版 `latest.yml`，避免客户端读取到
引用不完整文件的清单。
