#!/usr/bin/env bash
# 运行全部验证实验
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
export OPENCLAW_DIR="${OPENCLAW_DIR:-$(cd "$DIR/../../openclaw" && pwd)}"

echo "OpenClaw 目录: $OPENCLAW_DIR"
echo ""

PASS=0
FAIL=0

for script in "$DIR"/0*.sh; do
  name=$(basename "$script")
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if bash "$script"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "总计: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
