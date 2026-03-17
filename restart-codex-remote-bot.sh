#!/usr/bin/env bash
set -euo pipefail

BOT_DIR="/home/reinaldomh2009/assistant/codex-remote-bot"
SERVICE="codex-remote-bot.service"
MODE="${1:-run}"

cd "$BOT_DIR"

if [ "$MODE" = "run" ]; then
  WINDOWS_HOST_IP="$(ip route | awk '/default/ {print $3; exit}')"
  export OLLAMA_BASE_URL="http://${WINDOWS_HOST_IP}:11434/api"
  exec /usr/bin/env node "$BOT_DIR/index.js"
fi

if [ "$MODE" != "deploy" ]; then
  echo "[ERROR] Unknown mode: $MODE" >&2
  echo "[ERROR] Use: run | deploy" >&2
  exit 2
fi

echo "[INFO] Updating repo in: $BOT_DIR"
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