#!/usr/bin/env bash
# 实验 1：验证多 Agent + 多 Account + Bindings 路由
# 验证一个 gateway 能正确解析多个 agent 并通过 bindings 路由到对应的 channel account
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$(cd "$(dirname "$0")/../../openclaw" && pwd)}"
WORK_DIR=$(mktemp -d)
trap "rm -rf $WORK_DIR" EXIT

echo "=== 实验 1：多 Agent + Bindings 路由 ==="
echo "openclaw: $OPENCLAW_DIR"
echo "workdir: $WORK_DIR"

# 生成多租户 config
cat > "$WORK_DIR/config.json" <<'EOF'
{
  "gateway": {
    "port": 19999,
    "mode": "local",
    "bind": "loopback",
    "auth": { "mode": "token", "token": "test-token" },
    "reload": { "mode": "hybrid" }
  },
  "agents": {
    "list": [
      { "id": "tenant-a", "name": "Tenant A Bot", "default": true, "workspace": "/tmp/nexu-exp/ws-a" },
      { "id": "tenant-b", "name": "Tenant B Bot", "workspace": "/tmp/nexu-exp/ws-b" },
      { "id": "tenant-c", "name": "Tenant C Bot", "workspace": "/tmp/nexu-exp/ws-c" }
    ]
  },
  "channels": {
    "feishu": {
      "accounts": {
        "feishu-a": { "appId": "cli_fake_a", "appSecret": "secret_a", "connectionMode": "websocket", "enabled": false },
        "feishu-b": { "appId": "cli_fake_b", "appSecret": "secret_b", "connectionMode": "websocket", "enabled": false }
      }
    }
  },
  "bindings": [
    { "agentId": "tenant-a", "match": { "channel": "feishu", "accountId": "feishu-a" } },
    { "agentId": "tenant-b", "match": { "channel": "feishu", "accountId": "feishu-b" } }
  ]
}
EOF

mkdir -p /tmp/nexu-exp/{ws-a,ws-b,ws-c}

# 运行 agents list
OUTPUT=$(OPENCLAW_CONFIG_PATH="$WORK_DIR/config.json" \
  OPENCLAW_STATE_DIR="$WORK_DIR/state" \
  node "$OPENCLAW_DIR/dist/entry.js" agents list --bindings 2>&1)

echo "$OUTPUT"

# 验证
AGENT_COUNT=$(echo "$OUTPUT" | grep -c "^- tenant-")
BINDING_A=$(echo "$OUTPUT" | grep -c "feishu accountId=feishu-a")
BINDING_B=$(echo "$OUTPUT" | grep -c "feishu accountId=feishu-b")

echo ""
echo "=== 结果 ==="
if [ "$AGENT_COUNT" -eq 3 ] && [ "$BINDING_A" -eq 1 ] && [ "$BINDING_B" -eq 1 ]; then
  echo "PASS: 3 agents 解析正确，2 bindings 路由正确"
else
  echo "FAIL: agents=$AGENT_COUNT (期望 3), binding-a=$BINDING_A, binding-b=$BINDING_B (各期望 1)"
  exit 1
fi
