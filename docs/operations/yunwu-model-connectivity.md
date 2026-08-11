# Yunwu Model Connectivity Runbook

This runbook describes the supported path from a Claw-Pi desktop install to
the Yunwu OpenAI-compatible API.

## Connection Model

The desktop application has two separate network layers:

* Local services bind to loopback only:
  * OpenClaw Gateway: `127.0.0.1:<openclaw-port>` (normally `18789`)
  * Controller: `127.0.0.1:<controller-port>` (normally `50800`)
  * Web surface: `127.0.0.1:<web-port>` (normally `50810`)
* Model traffic goes from the Controller/OpenClaw sidecars to
  `https://yunwu.ai/v1`.

Do not replace the Yunwu URL with a local port. A local port is only the
workbench control plane; it is not a model proxy.

## Client Changes

The desktop bootstrap must resolve the operating-system/PAC proxy before it
selects either the orchestrator or launchd bootstrap path. The resolved
HTTP(S) proxy is passed to child processes as `HTTP_PROXY`, `HTTPS_PROXY`,
`NO_PROXY`, and `NODE_USE_ENV_PROXY=1`. `NO_PROXY` must include
`localhost,127.0.0.1,::1` so local health checks and WebSocket traffic stay
local.

The OpenClaw launcher is a readiness prerequisite. After sidecar extraction,
the client checks the exact launcher path before starting Controller or
launchd. A missing development launcher reports the preparation command; a
missing packaged launcher reports a damaged installation and stops quickly.

## Packaged Build Changes

Formal builds must contain the runtime sidecar and its launcher:

```text
resources/runtime/openclaw/bin/openclaw.cmd   # Windows
resources/runtime/openclaw/bin/openclaw       # macOS/Linux
resources/runtime/openclaw/node_modules/openclaw/openclaw.mjs
resources/build-config.json
```

The build configuration must point the model provider at:

```text
NEXU_LINK_URL=https://yunwu.ai
```

The Cloud endpoint and the Link/model endpoint are different settings. Keep
the Cloud account service URL in `NEXU_CLOUD_URL`; keep the Yunwu model service
URL in `NEXU_LINK_URL`. Do not put API keys in `build-config.json`, plist files,
Nginx configuration, or release logs.

Before publishing an installer, verify the unpacked package contains the
launcher and run the existing endpoint probe. Cloud `/v1/models` must return
HTTP 200. Yunwu may return HTTP 200, 401, or 403 when the probe does not send
credentials.

## Server Configuration

The Yunwu application should listen on `127.0.0.1` or a private network
address. Expose only HTTPS through the public reverse proxy. Replace
`127.0.0.1:YOUR_YUNWU_UPSTREAM_PORT` below with the actual Yunwu service port.

`/etc/nginx/conf.d/yunwu.ai.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name yunwu.ai;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name yunwu.ai;

    ssl_certificate     /etc/letsencrypt/live/yunwu.ai/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yunwu.ai/privkey.pem;

    location /v1/ {
        proxy_pass http://127.0.0.1:YOUR_YUNWU_UPSTREAM_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 30s;
        proxy_send_timeout 900s;
        proxy_read_timeout 900s;
    }
}
```

The reverse proxy must pass through at least:

* `/v1/models`
* `/v1/chat/completions`
* `/v1/responses`
* `/v1/images/`
* `/v1/dashboard/billing/`

If the Cloud account service is hosted by the same Nginx instance, proxy its
`/api/auth/` and account/billing routes separately to the Cloud upstream. Do
not merge Cloud account routes and Yunwu model routes merely because both use
OpenAI-compatible request shapes.

Server checklist:

1. DNS `yunwu.ai` points to the server's public address.
2. The certificate covers `yunwu.ai` and renews successfully.
3. TCP 443 is allowed by the firewall; the model process is not publicly
   bound.
4. Nginx configuration passes `nginx -t`, then is reloaded.
5. From an external client, `/v1/models` returns an expected status and an
   authenticated chat completion can stream for more than one minute.

## Verification

On Windows:

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -in 18789,50800,50810

curl.exe -I https://yunwu.ai/v1/models
curl.exe -v https://yunwu.ai/v1/models -H "Authorization: Bearer REDACTED"
```

For an installed package, inspect the bundled endpoint configuration:

```powershell
Get-Content "$env:LOCALAPPDATA\Programs\Claw-Pi\resources\build-config.json"
```

The value used by the model provider must remain `https://yunwu.ai` as the
origin, with `/v1` appended by the OpenAI-compatible client.
