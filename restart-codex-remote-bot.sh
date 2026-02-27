#!/usr/bin/env bash
set -euo pipefail

BOT_DIR="/home/reinaldomh2009/assistant/codex-remote-bot"
SERVICE="codex-remote-bot.service"

echo "[INFO] Updating repo in: $BOT_DIR"
cd "$BOT_DIR"

git fetch --all --prune
git pull --ff-only || {
  echo "[ERROR] git pull failed (non-fast-forward). Resolve manually." >&2
  exit 2
}

echo "[INFO] Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "[INFO] Restarting service: $SERVICE"
systemctl --user daemon-reload
systemctl --user restart "$SERVICE"

echo "[INFO] Status:"
systemctl --user status "$SERVICE" --no-pager

echo "[INFO] Last logs:"
journalctl --user -u "$SERVICE" -n 50 --no-pager -o cat