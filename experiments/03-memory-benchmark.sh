#!/usr/bin/env bash
# 实验 3：测量每 Agent 内存开销
# 生成 N 个 agent 的 config，启动 gateway，测量 RSS
set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$(cd "$(dirname "$0")/../../openclaw" && pwd)}"
AGENT_COUNT="${1:-50}"
WORK_DIR=$(mktemp -d)
LOG_FILE="$WORK_DIR/gateway.log"

cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== 实验 3：${AGENT_COUNT} Agent 内存测量 ==="

# 生成 config
python3 -c "
import json, sys
n = int(sys.argv[1])
agents = []
accounts = {}
bindings = []
for i in range(n):
    aid = f'bot-{i:04d}'
    fid = f'acct-{i:04d}'
    agents.append({
        'id': aid, 'name': f'Bot {i}',
        'workspace': f'/tmp/nexu-exp3/ws-{aid}',
        **({'default': True} if i == 0 else {})
    })
    accounts[fid] = {'appId': f'cli_{i:04d}', 'appSecret': f's{i}', 'connectionMode': 'websocket', 'enabled': False}
    bindings.append({'agentId': aid, 'match': {'channel': 'feishu', 'accountId': fid}})

config = {
    'gateway': {'port': 19997, 'mode': 'local', 'bind': 'loopback', 'auth': {'mode': 'token', 'token': 'test'}, 'reload': {'mode': 'hybrid'}},
    'agents': {'list': agents},
    'channels': {'feishu': {'accounts': accounts}},
    'bindings': bindings,
    'plugins': {'entries': {'feishu': {'enabled': True}}}
}
with open('$WORK_DIR/config.json', 'w') as f:
    json.dump(config, f, indent=2)
print(f'Generated config: {n} agents, {n} accounts, {n} bindings')
" "$AGENT_COUNT"

# 创建 workspace 目录
for i in $(seq -f "%04g" 0 $((AGENT_COUNT - 1))); do
  mkdir -p "/tmp/nexu-exp3/ws-bot-$i"
done

# 启动 gateway
OPENCLAW_CONFIG_PATH="$WORK_DIR/config.json" \
  OPENCLAW_STATE_DIR="$WORK_DIR/state" \
  node "$OPENCLAW_DIR/dist/entry.js" gateway run --port 19997 --bind loopback --force > "$LOG_FILE" 2>&1 &
GW_PID=$!

echo "Gateway PID: $GW_PID"
echo "等待启动..."
sleep 10

if ! ps -p "$GW_PID" > /dev/null 2>&1; then
  echo "FAIL: Gateway 未启动"
  tail -20 "$LOG_FILE"
  exit 1
fi

# 测量内存
RSS_KB=$(ps -p "$GW_PID" -o rss= | tr -d ' ')
RSS_MB=$(echo "scale=1; $RSS_KB / 1024" | bc)

# 验证 agent 数量
LISTED=$(OPENCLAW_CONFIG_PATH="$WORK_DIR/config.json" \
  OPENCLAW_STATE_DIR="$WORK_DIR/state" \
  node "$OPENCLAW_DIR/dist/entry.js" agents list 2>&1 | grep -c "^- bot-" || true)

echo ""
echo "=== 结果 ==="
echo "Agent 数量: $LISTED / $AGENT_COUNT"
echo "RSS: ${RSS_MB} MB (${RSS_KB} KB)"
echo "每 Agent 平均: $(echo "scale=2; $RSS_KB / $AGENT_COUNT / 1024" | bc) MB"

if [ "$LISTED" -eq "$AGENT_COUNT" ]; then
  echo "PASS"
else
  echo "FAIL: 期望 $AGENT_COUNT agents，实际 $LISTED"
  exit 1
fi
