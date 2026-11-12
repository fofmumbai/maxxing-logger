#!/usr/bin/env bash
# Mumbai Maxing: server setup and updates for Ubuntu 22.04 / 24.04 (Google Compute Engine).
#
# First run: installs Node.js + Caddy (automatic HTTPS), installs the app, asks for the domain and the
#            admin password, and starts everything as a service that restarts on crash or reboot.
# Later runs: updates the app code from a newer bundle and keeps all data and settings.
#
# Usage, in the VM's SSH window, after uploading mumbaimaxing-deploy.tar.gz (+ google-oauth-client.json):
#   sudo bash setup.sh
set -euo pipefail

APP_DIR=/opt/mumbaimaxing
DATA_DIR=/var/lib/mumbaimaxing
CONF_DIR=/etc/mumbaimaxing
ENV_FILE=$CONF_DIR/app.env
SERVICE=mumbaimaxing

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run with sudo:  sudo bash setup.sh"

USER_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
find_file() { { for d in "$SCRIPT_DIR" "$USER_HOME" "$PWD"; do ls -t "$d"/$1 2>/dev/null || true; done; } | head -1 || true; }

BUNDLE=$(find_file 'mumbaimaxing-deploy*.tar.gz')
[ -n "$BUNDLE" ] || fail "mumbaimaxing-deploy.tar.gz not found. Upload it to this machine first."
FIRST_RUN=0; [ -f "$ENV_FILE" ] || FIRST_RUN=1

# ---------- System packages (first run only) ----------
if [ $FIRST_RUN -eq 1 ]; then
  say "Installing system packages (takes 2–3 minutes)…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 >/dev/null

  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    say "Installing Node.js 20…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi

  if ! command -v caddy >/dev/null; then
    say "Installing Caddy (web server with automatic HTTPS)…"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi

  # Small machines can run out of memory while installing packages; a swap file prevents that.
  if ! swapon --show 2>/dev/null | grep -q .; then
    say "Adding a 2 GB swap file…"
    if fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
      grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    else
      rm -f /swapfile; echo "   (swap not available here, skipped)"
    fi
  fi

  id $SERVICE >/dev/null 2>&1 || useradd --system --home-dir $APP_DIR --shell /usr/sbin/nologin $SERVICE
fi

# ---------- App code ----------
say "Installing app from $(basename "$BUNDLE")…"
rm -rf "$APP_DIR.new" && mkdir -p "$APP_DIR.new"
tar -xzf "$BUNDLE" -C "$APP_DIR.new" --strip-components=1
(cd "$APP_DIR.new" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP_DIR.new"

# ---------- Settings (first run only) ----------
mkdir -p "$CONF_DIR" "$DATA_DIR"
chown $SERVICE:$SERVICE "$DATA_DIR" && chmod 750 "$DATA_DIR"

OAUTH_SRC=$(find_file 'google-oauth-client*.json')
[ -z "$OAUTH_SRC" ] && OAUTH_SRC=$(find_file 'client_secret_*.json')
if [ -n "$OAUTH_SRC" ]; then
  install -m 640 -o root -g $SERVICE "$OAUTH_SRC" "$CONF_DIR/google-oauth-client.json"
  rm -f "$OAUTH_SRC"   # don't leave the secret lying around in the home folder
  say "Google OAuth client file installed."
fi

if [ $FIRST_RUN -eq 1 ]; then
  IP=$(curl -fs -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || curl -fs https://api.ipify.org || true)
  FALLBACK=${IP:+$(echo "$IP" | tr . -).sslip.io}
  echo
  echo "Which web address should the app use?"
  echo "  • Your own subdomain, e.g. maxing.fofmumbai.com (its DNS A record must already point to ${IP:-this server})"
  [ -n "$FALLBACK" ] && echo "  • Or press Enter to use a free address: $FALLBACK"
  read -rp "Domain: " DOMAIN
  DOMAIN=${DOMAIN:-$FALLBACK}
  DOMAIN=$(echo "$DOMAIN" | sed -E 's#^https?://##; s#/.*$##' | tr 'A-Z' 'a-z')
  [ -n "$DOMAIN" ] || fail "A domain is required."

  while :; do
    read -rsp "Choose the organiser (admin) password (min 8 characters): " PW; echo
    [ ${#PW} -ge 8 ] || { echo "Too short, try again."; continue; }
    read -rsp "Type it again: " PW2; echo
    [ "$PW" = "$PW2" ] && break || echo "They don't match, try again."
  done

  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  umask 077
  cat > "$ENV_FILE" <<EOF
# Mumbai Maxing settings. Edit with: sudo nano $ENV_FILE  then: sudo systemctl restart $SERVICE
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://$DOMAIN
DATA_DIR=$DATA_DIR
ADMIN_PASSWORD="$(esc "$PW")"
GOOGLE_OAUTH_CLIENT_FILE=$CONF_DIR/google-oauth-client.json
TEAM_COUNT=25
MAX_MEMBERS=4
MAX_FILE_MB=300
EOF
  chmod 600 "$ENV_FILE"

  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	request_body {
		max_size 400MB
	}
	reverse_proxy 127.0.0.1:3000 {
		# Stream live updates (Server-Sent Events) without buffering.
		flush_interval -1
	}
}
EOF

  cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Mumbai Maxing
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable $SERVICE caddy >/dev/null 2>&1
fi

# ---------- Swap in the new code and (re)start ----------
systemctl stop $SERVICE 2>/dev/null || true
rm -rf "$APP_DIR.old"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
mv "$APP_DIR.new" "$APP_DIR"
systemctl start $SERVICE
systemctl reload caddy 2>/dev/null || systemctl restart caddy
rm -f "$BUNDLE"

say "Checking the app…"
for i in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:3000/ && break; sleep 1; done
if curl -fs -o /dev/null http://127.0.0.1:3000/; then
  rm -rf "$APP_DIR.old"
  DOMAIN=$(grep '^PUBLIC_URL=' "$ENV_FILE" | sed 's#PUBLIC_URL=https://##')
  journalctl -u $SERVICE -n 5 --no-pager -o cat | sed 's/^/   /'
  cat <<EOF

$( [ $FIRST_RUN -eq 1 ] && echo '✅ Mumbai Maxing is installed.' || echo '✅ Mumbai Maxing is updated. All data and settings were kept.' )

   Team app:   https://$DOMAIN
   Organisers: https://$DOMAIN/admin

$( [ $FIRST_RUN -eq 1 ] && cat <<EOT
Next:
  1. In Google Cloud → Google Auth Platform → Clients → your client, add this Authorized redirect URI:
        https://$DOMAIN/oauth/google/callback
  2. Open https://$DOMAIN/admin → Settings → Connect Google Drive.
  (The HTTPS certificate is issued automatically on first visit. If the page doesn't load yet, wait a minute and retry.)
EOT
)
Useful commands:
  sudo journalctl -u $SERVICE -f        live server log
  sudo systemctl restart $SERVICE       restart the app
  sudo nano $ENV_FILE           change settings (then restart)
EOF
else
  echo "The app did not start. Last log lines:"
  journalctl -u $SERVICE -n 30 --no-pager -o cat
  if [ -d "$APP_DIR.old" ]; then
    echo "Rolling back to the previous version…"
    systemctl stop $SERVICE; rm -rf "$APP_DIR"; mv "$APP_DIR.old" "$APP_DIR"; systemctl start $SERVICE
  fi
  exit 1
fi
