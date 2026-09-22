#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/biliterminal-server-compat"
APP_USER="biliterminal"
DOMAIN="jp.031030.xyz"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install-debian-systemd.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. Install Node.js 18+ first." >&2
  echo "Debian example: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "logs/stacks.ndjson" \
  ./ "${APP_DIR}/"

mkdir -p "${APP_DIR}/data" "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

install -m 0644 "${APP_DIR}/deploy/biliterminal-compat.service" /etc/systemd/system/biliterminal-compat.service
systemctl daemon-reload
systemctl enable --now biliterminal-compat.service

echo "Installed biliterminal-compat.service"
systemctl --no-pager --full status biliterminal-compat.service || true

cat <<EOF

Next:
1. Make sure DNS A record for ${DOMAIN} points to this server.
2. Install Caddy and copy deploy/Caddyfile:
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install -y caddy
   sudo cp ${APP_DIR}/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl reload caddy
3. Test:
   curl https://${DOMAIN}/healthz
EOF
