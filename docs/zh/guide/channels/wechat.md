# 微信

通过 nexu 客户端，只需 **扫一次码**，即可将微信 OpenClaw 🦞 ClawBot 接入你的个人微信——全程不到 5 分钟。

## 前置条件

- **微信版本** ≥ 8.0.7（支持 ClawBot 插件的最低版本）
- **macOS** 12+（Apple Silicon）

## 第一步：更新微信至 8.0.7

在微信中将版本更新到 8.0.7 或更高版本。这是支持 ClawBot 插件的最低版本。

## 第二步：下载并安装 nexu

1. 打开 [Claw Pi 官网](https://clawpi.app)，点击「下载 Mac 客户端」。

![nexu 官网下载页](/assets/wechat/step1-download.webp)

2. 下载完成后，打开 `.dmg` 文件，将 **Nexu** 图标拖入 **Applications** 文件夹。

![安装 nexu](/assets/wechat/step1-install.webp)

## 第三步：启动 nexu 并登录

1. 从「应用程序」中打开 nexu。
2. 在欢迎页面选择登录方式：
   - **Use your Nexu account**（推荐）：使用 nexu 账号登录，即可免费使用 Claude、GPT、Gemini 等顶级模型。
   - **Use your own models (BYOK)**：填入自己的 API Key，无需注册。

![选择登录方式](/assets/wechat/step2-login.webp)

## 第四步：选择微信渠道

登录后进入 nexu 首页，在「Choose a channel to get started」区域中点击 **WeChat**。

![选择 WeChat 渠道](/assets/wechat/step3-choose-wechat.webp)

## 第五步：扫码连接微信

1. 弹出「连接微信」对话框后，点击绿色的「扫码连接」按钮。

![点击扫码连接](/assets/wechat/step4-connect-dialog.webp)

2. nexu 会自动安装微信 ClawBot 插件并生成二维码，页面显示「等待扫码...」。

![等待扫码](/assets/wechat/step4-scan-qrcode.webp)

3. 打开手机上的 **微信**，使用「扫一扫」扫描屏幕上的二维码，然后在手机上点击 **确认连接**。

## 第六步：连接成功

扫码确认后，nexu 首页的微信渠道会显示 **已连接** 状态。

![微信已连接](/assets/wechat/step5-connected.webp)

## 第七步：在微信中对话

打开微信，你会看到一个名为 **微信 ClawBot** 的对话。直接发消息就能和你的 OpenClaw Agent 聊天——手机上随时随地可用，不受桌面限制。

![微信中与 ClawBot 对话](/assets/wechat/step6-chat.webp)

---

## 常见问题

**Q: 需要公网服务器吗？**

不需要。nexu 通过微信 ClawBot 插件直连，无需公网 IP 或回调地址。

**Q: 需要企业微信或公众号吗？**

不需要。微信 8.0.7 原生支持 ClawBot 插件，个人微信即可使用。

**Q: 会不会被封号？**

不会。ClawBot 是微信官方推出的插件，完全合规。

**Q: 手机和电脑都关了，Agent 还能回复吗？**

需要保持 nexu 客户端运行。只要 nexu 在后台运行（电脑不休眠），Agent 就能 7×24 小时在线回复微信消息。

**Q: 可以同时接入多个渠道吗？**

可以。nexu 支持同时连接微信、飞书、Slack、Discord 等多个渠道。

**Q: 如何切换 AI 模型？**

在 nexu 首页顶部的模型选择器中即可一键切换 Claude、GPT、Gemini 等模型。
