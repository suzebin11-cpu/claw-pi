# 支付宝电脑网站支付接入方案

## 背景

当前充值流程依赖「充值码」兑换，本地 Controller 代理到云端 `duen-server` 的 `/api/auth/redeem-recharge`。现需接入支付宝「订单码支付」（`alipay.trade.precreate`），让用户可以直接在应用内扫码付款充值。

## 架构分工

| 仓库 | 职责 |
|------|------|
| **`duen-server`**（云端后端） | 持有支付宝密钥（证书模式），调用 `alipay.trade.precreate` 生成二维码，接收异步回调，验证支付，加余额入库 |
| **`claw-pi-desktop`**（桌面前端 + 本地 Controller） | Controller 做代理转发，Web 做支付 UI，应用内展示二维码 |

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Web 前端    │────▶│ 本地Controller│────▶│  duen-server     │────▶│  支付宝 API   │
│ (localhost)  │◀────│  (代理转发)   │◀────│ (claw-pi.cn)     │◀────│              │
└─────────────┘     └──────────────┘     └──────────────────┘     └──────────────┘
       │                                        │
  应用内展示二维码                           PostgreSQL
  (qrcode.react)                          (订单 + 余额)
```

### 主成功链路

**应用内二维码 → 用户扫码支付 → 云端 notify 入账 → 应用内轮询刷新余额。**

- `notify_url`（云端异步回调）是入账主通道
- 前端轮询是用户体验通道（让 UI 及时反映支付结果）
- 全程不离开应用，无需跳转浏览器

---

## 支付流程

```
1. 用户选择金额 → 点击「支付宝支付」
2. Web 前端 → POST /api/internal/payment/alipay/create-order { amount_cents }
3. 本地 Controller 代理 → POST {cloudUrl}/api/payment/alipay/create-order
4. duen-server 调用 alipay.trade.precreate → 生成订单号 → 入库 → 返回 { qr_code, out_trade_no }
   （qr_code 是支付宝返回的二维码链接 URL）
5. 前端用 qrcode.react 将 qr_code 渲染为二维码图片，直接展示在页面内
6. 用户打开支付宝 → 扫一扫 → 完成付款
7. 支付宝异步回调 → POST https://claw-pi.cn/api/payment/alipay/notify
   → duen-server 验签 → DB 级幂等确认 → 加余额入库（★ 主入账通道）
8. 同时：前端轮询 → POST /api/internal/payment/alipay/query-order { out_trade_no }
   → duen-server 查 DB 订单状态 → 返回 { status, added_cents }
9. 前端收到 status: "paid" → 刷新余额，显示成功
```

### 关键设计决策

#### 1. 应用内二维码，不跳浏览器

使用 `alipay.trade.precreate`（订单码支付）获取二维码链接，前端用 `qrcode.react` 直接渲染。用户无需离开应用，打开支付宝扫一扫即可。不涉及 `window.open()`、`shell.openExternal()`、中转页或 `return_url`。

#### 2. 证书模式加签

APPID: `2021006145658419`，使用 RSA2 证书模式（非公钥模式）。duen-server 需要 4 个文件：应用私钥 + appCertPublicKey.crt + alipayCertPublicKey_RSA2.crt + alipayRootCert.crt。

#### 3. DB 级幂等，防止并发重复入账

`notify` 回调和前端 `query-order` 轮询可能同时触发确认。应用层读状态判断在并发下不安全。

**方案**：用单条原子 SQL 确认订单：

```sql
UPDATE payment_orders
SET status = 'paid', trade_no = $1, paid_at = NOW(), updated_at = NOW()
WHERE out_trade_no = $2 AND status = 'pending'
RETURNING id, user_id, amount_cents;
```

受影响行数 = 0 → 已被其他请求确认，直接返回当前状态。
受影响行数 = 1 → 首次确认，继续执行加余额事务。

#### 4. 查询与确认分离，强制 ownership 校验

| 操作 | 调用方 | 是否校验 user_id |
|------|--------|-----------------|
| `queryOrderForUser(outTradeNo, userId)` | 前端轮询（带 JWT） | 是，必须匹配 |
| `confirmPayment(outTradeNo, tradeNo)` | notify 回调 / 补偿任务 | 否（内部调用，靠验签保护） |

前端查询路由：必须验证 `payment_orders.user_id = JWT.userId`，防止订单状态泄露。

---

## 订单状态机

```
                       ┌──────────┐
                       │ pending  │ ← 创建订单
                       └────┬─────┘
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │   paid   │  │  closed  │  │  failed  │
        └──────────┘  └──────────┘  └──────────┘
```

| 状态 | 触发条件 | 说明 |
|------|---------|------|
| `pending` | 创建订单 | 等待支付 |
| `paid` | notify 验签通过且 `trade_status=TRADE_SUCCESS`，或 query 主动确认 | 已支付，余额已入账 |
| `closed` | 用户主动取消，或超时关闭（30 分钟） | 订单终止 |
| `failed` | 支付宝返回失败状态 | 支付失败 |

### 边界场景处理

| 场景 | 处理方式 |
|------|---------|
| **用户主动取消** | `POST /api/payment/alipay/cancel-order`，将 `pending` → `closed`，可选调用 `alipay.trade.close` 关单 |
| **超时自动关闭** | 定时任务（每 5 分钟）扫描 `pending` 且 `created_at < NOW() - 30min` 的订单，先调 `alipay.trade.query` 确认未支付 → `closed`；若已支付 → 走 `confirmPayment` 补偿入账 |
| **已关闭订单收到 TRADE_SUCCESS 回调** | `confirmPayment` 的原子 SQL 只更新 `status = 'pending'` 的行 → 不会命中已 `closed` 的订单 → 回调被安全忽略。定时补偿任务会兜底处理（查询支付宝确认真实状态后决定是否重新入账或退款） |
| **notify 和 query 并发** | DB 级原子更新保证只有一个请求能从 `pending` → `paid`，另一个读到最新状态直接返回 |

---

## Part 1: duen-server（云端后端）

### 1.1 新增数据库表

```sql
-- sql/008_payment_orders.sql

CREATE TABLE payment_orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  out_trade_no VARCHAR(64) UNIQUE NOT NULL,
  trade_no VARCHAR(64),
  channel VARCHAR(20) NOT NULL DEFAULT 'alipay',
  amount_cents INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  return_url TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notify_raw JSONB
);

CREATE INDEX idx_payment_orders_user ON payment_orders(user_id);
CREATE INDEX idx_payment_orders_status ON payment_orders(status);
CREATE INDEX idx_payment_orders_trade_no ON payment_orders(trade_no);
CREATE INDEX idx_payment_orders_pending_timeout
  ON payment_orders(created_at) WHERE status = 'pending';
```

### 1.2 环境变量

```env
# 支付宝（证书模式）
ALIPAY_APP_ID=2021006145658419
ALIPAY_PRIVATE_KEY_PATH=/etc/nexu/alipay-private-key.pem
ALIPAY_APP_CERT_PATH=/etc/nexu/appCertPublicKey.crt
ALIPAY_PUBLIC_CERT_PATH=/etc/nexu/alipayCertPublicKey_RSA2.crt
ALIPAY_ROOT_CERT_PATH=/etc/nexu/alipayRootCert.crt
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_NOTIFY_URL=https://claw-pi.cn/api/payment/alipay/notify
```

### 1.3 新增文件

| 文件 | 说明 |
|------|------|
| `src/services/alipay.ts` | 支付宝核心：RSA2 签名、表单构建、query 查询、notify 验签 |
| `src/services/payment.ts` | 支付业务：创建订单、DB 级幂等确认、加余额事务 |
| `src/routes/payment.ts` | 支付路由（含中转页） |
| `sql/008_payment_orders.sql` | 数据库迁移 |

### 1.4 路由设计

```
POST /api/payment/alipay/create-order    [JWT]   创建订单 → 调 precreate → 返回 { qr_code, out_trade_no }
POST /api/payment/alipay/query-order     [JWT]   查询订单状态（强制 user_id 校验）
POST /api/payment/alipay/cancel-order    [JWT]   用户主动取消（强制 user_id 校验）
POST /api/payment/alipay/notify          [无JWT] 支付宝异步回调（支付宝签名验证）
GET  /api/payment/alipay/pending-orders  [JWT]   用户的待支付订单列表（含 qr_code）
```

### 1.5 AlipayService

```typescript
// src/services/alipay.ts — 用 Node.js crypto，证书模式加签

class AlipayService {
  // 调用 alipay.trade.precreate（订单码支付），返回二维码链接
  async precreate(params: {
    out_trade_no: string;
    total_amount: string;      // "10.00"
    subject: string;
  }): Promise<{ qr_code: string }>

  // 调用 alipay.trade.query
  async queryTrade(outTradeNo: string): Promise<{
    trade_status: string;
    trade_no: string;
    total_amount: string;
  }>

  // 调用 alipay.trade.close
  async closeTrade(outTradeNo: string): Promise<boolean>

  // 验证 notify 回调签名（证书模式：从支付宝公钥证书提取公钥验签）
  verifyNotifySign(params: Record<string, string>): boolean
}
```

### 1.6 PaymentService

```typescript
// src/services/payment.ts

class PaymentService {
  // 创建订单 → 写 DB → 返回 pay_url
  async createOrder(userId: number, amountCents: number, returnUrl?: string): Promise<{
    out_trade_no: string;
    pay_url: string;
  }>

  // 用户查询（带 ownership 校验）
  async queryOrderForUser(outTradeNo: string, userId: number): Promise<{
    status: string;
    added_cents?: number;
    new_balance_cents?: number;
  }>

  // 内部确认入账（notify / 补偿任务调用）
  // 原子 SQL：UPDATE ... WHERE status = 'pending' RETURNING ...
  // → withTransaction → UPDATE users balance → INSERT quota_transactions → yunwu.addQuota
  async confirmPayment(outTradeNo: string, tradeNo: string, notifyRaw?: object): Promise<{
    status: string;
    added_cents?: number;
    new_balance_cents?: number;
  }>

  // 用户取消
  async cancelOrder(outTradeNo: string, userId: number): Promise<{ ok: boolean }>

  // 定时任务：超时关闭 + 补偿确认
  async closeExpiredOrders(): Promise<void>
}
```

### 1.7 notify 回调验签清单

收到 notify 后必须按顺序校验：

1. **签名验证** — `verifyNotifySign()` 使用支付宝公钥验证 RSA2 签名
2. **app_id** — 必须等于 `ALIPAY_APP_ID`，防止跨应用伪造
3. **out_trade_no** — 必须存在于 `payment_orders` 表
4. **total_amount** — 必须与 DB 中 `amount_cents / 100` 一致（注意单位转换：支付宝是元，DB 是分）
5. **seller_id** — 必须等于商户 PID（如有配置）
6. **trade_status** — 只在 `TRADE_SUCCESS` 或 `TRADE_FINISHED` 时入账

全部通过后调用 `confirmPayment()`，返回 `success` 给支付宝（否则支付宝会重复通知，最多 24 小时 8 次）。

### 1.8 定时任务

```typescript
// 每 5 分钟执行
async function closeExpiredOrders() {
  // 1. 查出所有 pending 且 created_at < NOW() - 30min 的订单
  // 2. 对每个订单调 alipay.trade.query
  //    - 如果支付宝返回 TRADE_SUCCESS → confirmPayment() 补偿入账
  //    - 如果支付宝返回 WAIT_BUYER_PAY → alipay.trade.close + DB status='closed'
  //    - 如果支付宝返回 TRADE_CLOSED → DB status='closed'
}
```

---

## Part 2: claw-pi-desktop（桌面前端 + 本地 Controller）

### 2.1 新增文件

| 文件 | 说明 |
|------|------|
| `packages/shared/src/schemas/payment.ts` | 支付相关 Zod schemas |
| `apps/controller/src/routes/payment-routes.ts` | 支付代理路由 |

### 2.2 修改文件

| 文件 | 变更 |
|------|------|
| `packages/shared/src/index.ts` | 导出新 schemas |
| `apps/controller/src/app/create-app.ts` | 注册 payment routes |
| `apps/controller/src/services/desktop-local-service.ts` | 新增支付代理方法 |
| `apps/web/src/pages/recharge.tsx` | 新增在线充值 UI |
| `apps/web/src/i18n/locales/zh-CN.ts` | 中文文案 |
| `apps/web/src/i18n/locales/en.ts` | 英文文案 |

### 2.3 Controller 代理逻辑

`create-order` 代理时，Controller 直接转发 `{ amount_cents }` 给云端，云端调 `alipay.trade.precreate` 返回 `{ qr_code, out_trade_no }`。不再需要 `return_url`，因为不跳浏览器。

### 2.4 前端交互

1. 选预设金额（¥10/30/50/100/200 或自定义） → 点「支付宝支付」
2. 调 `create-order` → 拿到 `qr_code`
3. 用 `qrcode.react` 的 `QRCodeSVG` 将 `qr_code` URL 渲染为二维码，直接展示在页面内
4. 启动轮询 `query-order`（3 秒间隔，最多 5 分钟）
5. 轮询到 `paid` → 成功提示 → 刷新余额 → 停止轮询
6. 超时未支付 → 提示「未检测到支付」，订单进入待支付列表
7. 待支付列表支持「展开二维码」（继续扫码）和「取消」

---

## 部署步骤

### duen-server

1. 运行 `sql/008_payment_orders.sql` 建表
2. 上传支付宝私钥到服务器（如 `/etc/nexu/alipay-private-key.pem`），权限 `600`
3. 在服务器 `.env` 配置 `ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY`
4. 配置 nginx：`claw-pi.cn/api/payment/*` → duen-server
5. 部署代码，重启服务
6. **沙箱验证**：用支付宝沙箱环境跑通 5 条路径（见下方）

### claw-pi-desktop

1. `pnpm generate-types` → `pnpm typecheck` → `pnpm lint` → `pnpm test`
2. 正常打包发布

---

## 验证计划

上线前必须跑通以下 5 条路径：

| # | 路径 | 验证点 |
|---|------|-------|
| 1 | **正常支付** | 创建订单 → 沙箱扫码 → notify 回调入账 → 轮询返回 paid → 余额正确 |
| 2 | **notify 重复通知** | 手动重放同一笔 notify → 余额不重复增加（幂等） |
| 3 | **notify + query 并发** | 同时触发 notify 和 query → 只入账一次 |
| 4 | **超时关闭** | 创建订单不支付 → 等 30 分钟 → 定时任务关闭 → 状态变 closed |
| 5 | **已关闭订单晚到回调** | 手动关闭订单 → 发送 TRADE_SUCCESS notify → 不入账（被原子 SQL 拦截） |

### 签名回归测试

手写签名实现需要单独的单元测试覆盖：

- 参数排序 + 拼接 + RSA2 签名 → 与支付宝沙箱对比
- notify 验签 → 用真实/构造的回调参数测试
- 字符编码（UTF-8）、空值过滤、sign_type 排除

---

## 依赖变更

| 仓库 | 说明 |
|------|------|
| `duen-server` | 签名用 `crypto`（证书模式），HTTP 用 `fetch`，DB 用现有 `pg`，定时用现有 `node-cron` |
| `claw-pi-desktop` | 代理用现有 `proxyFetch`，新增 `qrcode.react`（应用内二维码渲染） |

## 后续扩展

- **微信支付**：小程序 AppID 认证通过后，`duen-server` 新增 `WechatPayService`，复用 `/api/payment/wechat/*` 路由结构，`payment_orders.channel = 'wechat'`
- **对账**：后续加定时任务批量查询异常订单
- **退款**：预留 `refund` 状态和 `alipay.trade.refund` 接口封装
