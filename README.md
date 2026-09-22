# BiliTerminal compatibility server

This is a small private compatibility server for the BiliTerminal app-info API
used by `BiliClient-v2.9.5-fix`.

问题反馈：GitHub Issues 或 QQ 群 `1107953621`。提交日志时请先确认已过滤
Cookie、Token、Authorization 和其他账号凭据。

It implements only the endpoints that the archived Android client calls on
`api.biliterminal.cn`:

- `GET /terminal/version/get_last`
- `GET /terminal/version/get_download_url?version_code=...`
- `GET /terminal/announcement/get_list?from=...`
- `GET /terminal/config/get`
- `GET /terminal/update/manifest`
- `GET|POST /compat/v1/bili/<configured-route>?...`
- `POST /terminal/upload/stack`
- `GET /terminal/afdian/get_sponsor?page=...`
- `GET|POST /bili-relay/<allowed-host>/<path>?...`

The relay is optional, token-protected, and restricted to the allowlist in
`data/config.json`. It is meant for a private rebuilt client, not as an open
proxy.

## Run locally

Install dependencies with `npm ci` before starting the server.

### Browser Tunnel

The hidden Android browser uses `/browser-tunnel` over authenticated WSS when
relay mode is enabled. Enable it explicitly with `"browserRelay": {"enabled": true}`
in `data/config.json`; `relay.enabled` and the existing relay token must also be
configured. Caddy's existing reverse proxy supports the WebSocket upgrade.

The tunnel preserves original website URLs, cookies, POST bodies, and end-to-end
HTTPS certificate checks. It accepts only public destinations on ports 80 and 443.
Private/reserved IPs (including mapped IPv6), mixed public/private DNS answers,
browser-Origin handshakes and missing credentials are rejected. Each connection
is pinned to its validated destination IP. Connections, payloads and lifetimes
are bounded. No URLs beyond the destination host, page bodies or credentials are
written by this module to application logs.

The client requires WebView's `PROXY_OVERRIDE` feature. Unsupported WebViews and
failed tunnels do not silently fall back to direct website access. The feature
covers WebView HTTP(S)/WebSocket traffic, not other apps or WebRTC UDP traffic.
Only normal public web ports are supported; it is not a general VPN.

Tests: `node --test test/browser-tunnel.test.js`.

```bash
node server.js
```

Then test:

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/terminal/version/get_last
curl "http://127.0.0.1:3000/terminal/announcement/get_list?from=-1"
```

## Windows Server quick setup

Copy this folder to the server, install Node.js 18 or newer, then open
PowerShell as Administrator:

```powershell
cd "C:\path\to\biliterminal-server-compat"
.\scripts\install-windows-task.ps1
```

The script registers a startup task named `BiliTerminalCompatServer` and opens
the configured TCP port in Windows Firewall.

For the current production domain, the client API base is:

```text
https://jp.031030.xyz
```

To remove the startup task and firewall rule:

```powershell
.\scripts\uninstall-windows-task.ps1
```

## Configure

Edit `data/config.json`. The server reloads the JSON file for each request, so
small changes do not require a restart.

Important fields:

- `latestVersion.version_code`: Android `versionCode`.
- `latestVersion.version_name`: Android `versionName`.
- `latestVersion.can_download`: set to `1` only when `downloadUrls` contains a URL.
- `downloadUrls`: map version code strings to APK URLs.
- `announcements`: list shown by the client.
- `sponsors`: list shown on the sponsor page.
- `relay.enabled`: enables the private Bilibili relay.
- `relay.token`: shared token expected in `X-Relay-Token`.
- `relay.allowedHosts`: exact upstream hosts the relay may contact.
- `hotConfig`: signed, short-lived client configuration. Keep its RSA private
  key only on the server.
- `updateManifest`: signed full-package and optional differential-patch
  metadata.
- `compat.routes`: named upstream routes used by old clients. Changing an
  upstream URL here does not require an APK update.

Crash uploads are appended as NDJSON to `logs/stacks.ndjson`. Cookie and
authorization headers are intentionally not stored.

Relay URLs look like this:

```text
https://jp.031030.xyz/bili-relay/api.bilibili.com/x/web-interface/view?bvid=BV...
```

The server forwards the request to:

```text
https://api.bilibili.com/x/web-interface/view?bvid=BV...
```

Do not expose a `/proxy?url=...` style endpoint. Keeping this as an allowlisted
relay is the main thing that prevents the service from becoming an open proxy.

## Rebuilt client fallback behavior

The patched Android client is configured for private auto fallback:

- Normal state: request official Bilibili hosts directly.
- Fallback trigger: direct connection failures are retried 3 times with a
  5-second connect timeout each.
- Fallback state: once triggered, later API, image, danmaku, download, and
  player media URLs are rewritten through `/bili-relay`.
- Player retry: if the media player hits an online media error, it forces relay
  mode and retries the current media URL once.

This keeps normal traffic off the relay server and only spends server/mobile
data when the direct path is actually blocked or failing.

## Differential update entries

Differential updates use standard `BSDIFF40` patches. Each object in
`updateManifest.payload.patches` contains:

- `from_version_code`: installed Android version code.
- `from_sha256`: SHA-256 of the exact installed APK used to build the patch.
- `algorithm`: `bsdiff`.
- `url`: HTTPS patch URL on the terminal server.
- `sha256`: SHA-256 of the patch.
- `size`: patch size in bytes.

The client verifies the installed APK, patch, and reconstructed signed APK. If
any check fails, it deletes the partial output and downloads `full.url`.

## Debian + Caddy deployment

On the Debian server, install Node.js 18 or newer, copy this folder to the
server, then run from inside the folder:

```bash
sudo bash scripts/install-debian-systemd.sh
```

Then install Caddy and use the included reverse-proxy config:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
sudo cp /opt/biliterminal-server-compat/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Open ports `80/tcp` and `443/tcp`, then test:

```bash
curl https://jp.031030.xyz/healthz
```

Caddy will obtain and renew the TLS certificate automatically.

## Docker

```bash
docker build -t biliterminal-server-compat .
docker run -d --name biliterminal-server \
  -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/logs:/app/logs" \
  biliterminal-server-compat
```

## Nginx reverse proxy

Use HTTPS on your own domain, for example `api.example.com`, then proxy to this
Node service:

```nginx
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Client domain patch

The archived client hardcodes `api.biliterminal.cn` in:

`app/src/main/java/com/RobinNotBad/BiliClient/api/AppInfoApi.java`

The download URL endpoint is hardcoded as HTTPS. If you do not control
`api.biliterminal.cn`, the practical route is to rebuild the APK after changing
that file to your own HTTPS domain.

Replace:

```java
http://api.biliterminal.cn
https://api.biliterminal.cn
```

with:

```java
https://api.example.com
```

You can also disable update downloads by keeping `can_download` as `0`.
