#!/usr/bin/env bash
# 实验 2：验证 Config 热加载
# 验证 gateway 运行中修改 config 新增 agent/account/binding，热加载生效且不重启
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$(cd "$(dirname "$0")/../../openclaw" && pwd)}"
WORK_DIR=$(mktemp -d)
LOG_FILE="$WORK_DIR/gateway.log"

cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== 实验 2：Config 热加载 ==="

# 初始 config：2 个 agent
cat > "$WORK_DIR/config.json" <<'EOF'
{
  "gateway": { "port": 19998, "mode": "local", "bind": "loopback", "auth": { "mode": "token", "token": "test" }, "reload": { "mode": "hybrid" } },
  "agents": { "list": [
    { "id": "bot-1", "name": "Bot 1", "default": true, "workspace": "/tmp/nexu-exp2/ws-1" },
    { "id": "bot-2", "name": "Bot 2", "workspace": "/tmp/nexu-exp2/ws-2" }
  ]},
  "channels": { "feishu": { "accounts": {
    "acct-1": { "appId": "cli_1", "appSecret": "s1", "connectionMode": "websocket", "enabled": false }
  }}},
  "bindings": [
    { "agentId": "bot-1", "match": { "channel": "feishu", "accountId": "acct-1" } }
  ]
}
EOF

mkdir -p /tmp/nexu-exp2/{ws-1,ws-2,ws-3}

# 启动 gateway
OPENCLAW_CONFIG_PATH="$WORK_DIR/config.json" \
  OPENCLAW_STATE_DIR="$WORK_DIR/state" \
  node "$OPENCLAW_DIR/dist/entry.js" gateway run --port 19998 --bind loopback --force > "$LOG_FILE" 2>&1 &
GW_PID=$!
echo "Gateway PID: $GW_PID"
sleep 8

# 验证启动成功
if ! ps -p "$GW_PID" > /dev/null 2>&1; then
  echo "FAIL: Gateway 未启动"
  cat "$LOG_FILE"
  exit 1
fi
echo "Gateway 已启动，准备热加载..."

# 热加载：用 python 往 config 中新增 bot-3
python3 -c "
import json
with open('$WORK_DIR/config.json') as f:
    cfg = json.load(f)
cfg['agents']['list'].append({'id': 'bot-3', 'name': 'Bot 3 (hot-added)', 'workspace': '/tmp/nexu-exp2/ws-3'})
cfg['bindings'].append({'agentId': 'bot-3', 'match': {'channel': 'feishu', 'accountId': 'acct-3'}})
cfg['channels']['feishu']['accounts']['acct-3'] = {'appId': 'cli_3', 'appSecret': 's3', 'connectionMode': 'websocket', 'enabled': False}
with open('$WORK_DIR/config.json', 'w') as f:
    json.dump(cfg, f, indent=2)
print('Config updated: added bot-3')
"

# 等待 chokidar 检测
sleep 5

# 检查日志
echo ""
echo "=== Gateway reload 日志 ==="
grep -i "reload" "$LOG_FILE" | tail -10

RELOAD_COUNT=$(grep -c "config change detected" "$LOG_FILE" || true)
PID_AFTER=$(ps -p "$GW_PID" -o pid= 2>/dev/null | tr -d ' ')

echo ""
echo "=== 结果 ==="
if [ "$RELOAD_COUNT" -gt 0 ] && [ "$PID_AFTER" = "$GW_PID" ]; then
  echo "PASS: 检测到 $RELOAD_COUNT 次热加载，PID 不变 ($GW_PID)"
else
  echo "FAIL: reload_count=$RELOAD_COUNT, pid_before=$GW_PID, pid_after=$PID_AFTER"
  exit 1
fi
