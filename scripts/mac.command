#!/bin/bash
# Claw-Pi macOS Installer
#
# Uses pkgutil --expand-full instead of `installer` to avoid macOS bundle
# relocation (where the OS silently installs to a stale location).
# Only strips com.apple.quarantine — never xattr -cr — so the ad-hoc
# code signature stays intact for subsequent Finder launches.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$SCRIPT_DIR/claw-pi-macos"
APP_NAME="Claw-Pi.app"
DEFAULT_APP_PATH="/Applications/$APP_NAME"
EXPAND_DIR="/tmp/claw-pi-install-$$"

cleanup_expand_dir() {
    rm -rf "$EXPAND_DIR" 2>/dev/null || true
}
trap cleanup_expand_dir EXIT

echo ""
echo "========================================"
echo "       Claw-Pi macOS 安装程序"
echo "========================================"
echo ""

# ── 1. 定位 .pkg 文件 ──
PKG_FILE=$(find "$PKG_DIR" -maxdepth 1 -name "*.pkg" -type f 2>/dev/null | sort | head -1)

if [ -z "$PKG_FILE" ]; then
    echo "  [错误] 找不到安装包。"
    echo "  请确保 claw-pi-macos 文件夹中有 .pkg 文件。"
    echo ""
    read -n 1 -s -r -p "  按任意键退出..."
    exit 1
fi

echo "  安装包: $(basename "$PKG_FILE")"
echo ""

# ── 2. 关闭已运行的 Claw-Pi ──
if pgrep -x "Claw-Pi" > /dev/null 2>&1; then
    echo "  正在关闭运行中的 Claw-Pi..."
    pkill -x "Claw-Pi" 2>/dev/null || true
    sleep 2
fi

# ── 3. 去除安装包隔离标记 ──
echo "  正在准备安装包..."
xattr -d com.apple.quarantine "$PKG_FILE" 2>/dev/null || true

# ── 4. 提取 .pkg payload（绕过 installer 的 bundle relocation） ──
echo ""
echo "  即将安装 Claw-Pi，需要输入你的开机密码。"
echo "  （输入时屏幕不会显示任何字符，这是正常的）"
echo ""

echo "  正在提取安装包..."
cleanup_expand_dir
pkgutil --expand-full "$PKG_FILE" "$EXPAND_DIR"

# Locate the .app inside the expanded payload.
# The component pkg is usually named after the bundle id.
PAYLOAD_APP=""
for component_dir in "$EXPAND_DIR"/*/; do
    candidate="$component_dir/Payload/$APP_NAME"
    if [ -d "$candidate" ]; then
        PAYLOAD_APP="$candidate"
        break
    fi
done

if [ -z "$PAYLOAD_APP" ]; then
    # Flat pkg: Payload is directly under the expand root
    if [ -d "$EXPAND_DIR/Payload/$APP_NAME" ]; then
        PAYLOAD_APP="$EXPAND_DIR/Payload/$APP_NAME"
    fi
fi

if [ -z "$PAYLOAD_APP" ] || [ ! -d "$PAYLOAD_APP" ]; then
    echo ""
    echo "  [错误] 安装包中未找到 $APP_NAME。"
    echo "  请联系开发者。"
    echo ""
    read -n 1 -s -r -p "  按任意键退出..."
    exit 1
fi

# ── 5. 复制到 /Applications/ ──
echo "  正在安装到 /Applications/..."
sudo rm -rf "$DEFAULT_APP_PATH"
sudo cp -R "$PAYLOAD_APP" "$DEFAULT_APP_PATH"

if [ ! -d "$DEFAULT_APP_PATH" ]; then
    echo ""
    echo "  [错误] 安装失败，请重试。"
    echo ""
    read -n 1 -s -r -p "  按任意键退出..."
    exit 1
fi

echo ""
echo "  [OK] 安装完成！"

# ── 6. 仅去除隔离标记（保留代码签名完整性） ──
echo "  正在处理安全设置..."
sudo xattr -dr com.apple.quarantine "$DEFAULT_APP_PATH" 2>/dev/null || true
echo "  [OK] 安全设置已处理！"

# ── 7. 清除旧 installer receipt（如有） ──
if pkgutil --pkg-info app.clawpi.desktop > /dev/null 2>&1; then
    sudo pkgutil --forget app.clawpi.desktop > /dev/null 2>&1 || true
fi

# ── 8. 启动应用 ──
echo ""
echo "========================================"
echo "    安装完成！正在启动 Claw-Pi..."
echo "========================================"
echo ""

open "$DEFAULT_APP_PATH"
echo "  Claw-Pi 已启动！此窗口将在 5 秒后自动关闭。"

sleep 5
exit 0
