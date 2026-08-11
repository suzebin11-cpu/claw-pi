# 云雾模型云端网关配置

## 目标

桌面端只访问云端网关的 OpenAI 兼容接口，不要求用户寻找、填写或维护
代理节点。云端网关从服务器直接访问云雾上游；服务器若处于受限网络，
可以由运维在服务器进程环境中设置 `HTTPS_PROXY`，该配置不会下发到桌面端。

客户端兼容原有配置：

```text
desktop.cloud.linkUrl = https://api.example.com
model                = link/<existing-model-id>
```

网关应同时接受带 `/v1` 和不带 `/v1` 的旧地址，服务端统一转发到
`/v1/chat/completions`、`/v1/models` 等 OpenAI 兼容路径。

## 服务端环境变量

```dotenv
YUNWU_BASE_URL=https://yunwu.ai/v1
YUNWU_API_KEY=<server-side-secret>
YUNWU_TIMEOUT_MS=180000
MODEL_ROUTE_MAP={"gpt-5.5":"gpt-5.5","claude-sonnet-4-5":"claude-sonnet-4-5"}
```

`YUNWU_API_KEY` 只能存在于服务端密钥管理或服务进程环境中，不得写入桌面
配置、浏览器响应、日志或打包资源。`MODEL_ROUTE_MAP` 的左侧是对客户端
公开的稳定模型 ID，右侧是云雾实际模型 ID；旧模型名继续保留别名，避免
升级后用户配置失效。

服务端网关至少实现：

* `GET /v1/models`
* `POST /v1/chat/completions`
* 流式响应的 SSE 原样转发
* 云端访问令牌校验、限流和上游错误脱敏

请求流程固定为：

```text
桌面端 -> https://<cloud-host>/v1 -> 云端网关 -> https://yunwu.ai/v1
```

桌面端不应直接请求 `yunwu.ai`，也不应把 Yunwu key 放进
`Authorization` 头。

## Nginx 反向代理

应用网关监听服务器内网端口，例如 `127.0.0.1:50820`。Nginx 只负责 TLS
终止和转发，不要把云雾密钥写进 Nginx 配置：

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location /v1/ {
        proxy_pass http://127.0.0.1:50820;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

`proxy_pass` 不要额外拼接 `/v1`，这样客户端访问 `/v1/...` 时不会发生
双重路径。部署后先在服务器上验证内网网关，再验证公网域名：

```bash
curl -fsS http://127.0.0.1:50820/v1/models \
  -H "Authorization: Bearer <desktop-issued-token>"
curl -N https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer <desktop-issued-token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

## 向下兼容要求

1. 保留 `link/<model-id>` 命名空间，不迁移已有 bot 和桌面配置。
2. 旧的 `linkUrl` 不带 `/v1` 时由服务端路由兼容，客户端只在归一化时
   补路径，不改变模型 ID。
3. 云雾上游不可用时返回标准 OpenAI 错误结构和 5xx，不将内部代理地址、
   API key 或堆栈信息暴露给客户端。
4. 服务器直连是默认路径，`HTTPS_PROXY` 只能作为服务器运维兜底，不能
   作为用户侧前置条件。
