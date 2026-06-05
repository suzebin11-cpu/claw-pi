# 更新指南

## 方式一：客户端内直接更新（推荐）

1. 打开 Nexu
2. 点击顶部菜单栏 **Nexu**
3. 选择 **Check for Updates**
4. 如有新版本，按提示完成更新

> 最简单的方式，推荐优先使用

![Check for Updates](/assets/nexu-check-for-updates.webp)

---

## 方式二：手动下载安装包

前往以下任一地址下载最新版本：

- **官网：** [https://nexu.io/download](https://nexu.io/download)
- **GitHub Release：** [https://github.com/powerformer/nexu/releases](https://github.com/powerformer/nexu/releases)

---

## 更新时遇到问题？

请参考 [修复指南](/zh/guide/troubleshooting)。

---

## 发布前更新链路自检（维护者）

Windows 安装包发布到更新源后，需要确认 `latest.yml`、安装包和 blockmap 都能被客户端下载。

完整校验会下载安装包并计算 sha512：

```bash
pnpm verify:update-feed -- --expected-version <version>
```

只检查远端元数据和文件可访问性，不下载完整安装包：

```bash
pnpm verify:update-feed -- --expected-version <version> --metadata-only
```

默认检查：

```text
https://api.claw-pi.cn/updates/stable/x64/latest.yml
```

也可以指定自定义更新源：

```bash
pnpm verify:update-feed -- --feed-url https://api.claw-pi.cn/updates/stable/x64 --expected-version <version>
```

自检必须通过以下内容：

- `latest.yml` 可访问，版本号正确。
- `latest.yml` 内的 `path`、`files[0].url`、`sha512`、`size` 字段完整且一致。
- 安装包 `.exe` 可访问，大小与 `latest.yml` 一致。
- `.exe.blockmap` 可访问。
- 完整校验模式下，安装包 sha512 与 `latest.yml` 一致。

---

## 联系支持

如问题仍未解决，请通过以下方式联系我们：

- **Github Issue：** [https://github.com/nexu-io/nexu/issues](https://github.com/nexu-io/nexu/issues)
- **社群：** [https://docs.nexu.io/zh/guide/contact](/zh/guide/contact)
