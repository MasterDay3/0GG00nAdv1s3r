#!/usr/bin/env bash
# Installs or updates Dueboard on a fresh Ubuntu 24.04 server (AWS Lightsail / EC2). Safe to re-run.
#
#   sudo SITE_ADDRESS=dueboard.com.ua bash deploy/setup.sh   # with a domain: HTTPS via Let's Encrypt
#   sudo bash deploy/setup.sh                                # no domain yet: plain HTTP on the server's IP
#
# Optional: BRANCH (default main), REPO (default the GitHub repo).
# Settings live in /etc/dueboard.env (kept between runs; put TELEGRAM_BOT_TOKEN there).
set -euo pipefail

REPO="${REPO:-https://github.com/MasterDay3/0GG00nAdv1s3r.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/dueboard
DATA_DIR=/var/lib/dueboard
ENV_FILE=/etc/dueboard.env
export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)"; exit 1; }

# 1 GB swap: the smallest plan has only 512 MB RAM.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js 22 (node:sqlite needs 22.13+) and Caddy (HTTPS reverse proxy).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
apt-get install -y git sqlite3

id dueboard >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin dueboard
install -d -o dueboard -g dueboard -m 750 "$DATA_DIR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
PORT=3000
HOST=127.0.0.1
DB_PATH=$DATA_DIR/dueboard.db
COOKIE_SECURE=0
TELEGRAM_BOT_TOKEN=
ENV
  chmod 640 "$ENV_FILE" && chgrp dueboard "$ENV_FILE"
fi

# Caddy: a domain gets automatic HTTPS; without one, serve HTTP on port 80.
if [ -n "${SITE_ADDRESS:-}" ]; then
  sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=1/' "$ENV_FILE"
  SITE="$SITE_ADDRESS"
elif grep -q '^# site: ' /etc/caddy/Caddyfile 2>/dev/null; then
  SITE="$(sed -n 's/^# site: //p' /etc/caddy/Caddyfile)"
else
  SITE=":80"
fi
# The first address serves the app; any others (e.g. www.) redirect to it, so there is one login cookie.
PRIMARY="$(echo "$SITE" | cut -d, -f1 | xargs)"
{
  echo "# site: $SITE"
  printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' "$PRIMARY"
  for alias in $(echo "$SITE" | cut -s -d, -f2- | tr ',' ' '); do
    printf '%s {\n\tredir https://%s{uri} permanent\n}\n' "$alias" "$PRIMARY"
  done
} > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

install -m 644 "$APP_DIR/deploy/dueboard.service" /etc/systemd/system/dueboard.service
systemctl daemon-reload
systemctl enable --now dueboard caddy
systemctl restart dueboard
systemctl reload caddy || systemctl restart caddy

echo "Dueboard $(git -C "$APP_DIR" rev-parse --short HEAD) is running behind Caddy at: $SITE"
