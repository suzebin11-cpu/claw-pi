# 验证实验

验证 OpenClaw 多租户方案核心假设的实验脚本。

## 前置条件

- Node.js >= 22.12.0
- 已 clone 并构建 openclaw（`pnpm install && pnpm build`）

## 实验列表

| 脚本 | 验证内容 | 状态 |
|------|---------|------|
| `01-multi-agent-routing.sh` | 多 Agent + 多 Account + Bindings 路由 | 已通过 (2026-02-25) |
| `02-hot-reload.sh` | 运行中新增 agent，热加载生效不重启 | 已通过 (2026-02-25) |
| `03-memory-benchmark.sh` | 50 agent 内存开销测量 | 已通过 (2026-02-25) |

## 运行

```bash
# 设置 openclaw 路径
export OPENCLAW_DIR=/path/to/openclaw

# 运行单个实验
./experiments/01-multi-agent-routing.sh

# 运行全部实验
./experiments/run-all.sh
```
