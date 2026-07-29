# Claw-Pi 桌面版发布

桌面 OTA 由版本号驱动，不需要登录 Ubuntu 服务器拉取或覆盖 Electron 源码。

## 发布步骤

1. 将准备发布的改动合并到 `main`。
2. 把 `apps/desktop/package.json` 的 `version` 提升到新的 SemVer，例如 `0.3.16` 到 `0.3.17`。推荐通过 **Desktop Prepare Release** workflow 创建版本 PR。
3. 版本提交进入 `main` 后，**Desktop Auto-Tag on Version Change** 自动校验版本并创建 `v{version}` 标签。
4. 标签触发 **Desktop Release**，在 GitHub Actions 的 macOS/Windows runner 上构建、签名并校验安装包。
5. CI 先上传不可变产物，最后上传 `latest.yml` / `latest-mac.yml`，随后从 `https://api.clawpi.app:9443/updates` 验证公网更新源。
6. 公网验证通过后 GitHub Release 才正式发布。已安装客户端会立即检查，并每 15 分钟再次检查。

## 客户端行为

- 正式 NSIS/macOS 安装版自动后台下载更新。
- 下载完成后用户可以立即重启安装。
- 用户不立即重启时，更新会在应用正常退出后安装。
- portable 构建不参与自动更新。

## 发布闸门

- 普通源码 push 不发布客户端更新。
- 桌面版本必须符合 SemVer，且必须高于 `main` 上一个版本。
- 已存在且指向其他提交的同名标签会使发布失败。
- 清单版本、引用文件、SHA-512、文件大小、Windows `.blockmap` 和 SHA-256 文件必须完整。
- 公网更新源验证失败时，GitHub Release 保持草稿状态，不视为发布成功。

## 回滚

优先发布一个修复后的更高版本。必须回滚更新源时，先恢复上一版本的安装包和块映射，最后恢复上一版本的 `latest.yml` / `latest-mac.yml`，避免客户端读取到引用不完整文件的清单。
