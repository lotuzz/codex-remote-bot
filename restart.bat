@echo off
setlocal ENABLEDELAYEDEXPANSION

REM === SETTINGS ===
set "DISTRO=Ubuntu-24.04"
set "WSL_USER=reinaldomh2009"
set "BOT_DIR=/home/reinaldomh2009/assistant/codex-remote-bot"
set "SERVICE=codex-remote-bot.service"

echo [INFO] Restarting Codex Remote Bot in WSL...
echo [INFO] Distro=%DISTRO% User=%WSL_USER%
echo.

REM Run everything inside WSL
wsl.exe -d "%DISTRO%" -u "%WSL_USER%" -- bash -lc ^
  "set -euo pipefail; \
   echo '[WSL] cd %BOT_DIR%'; \
   cd '%BOT_DIR%'; \
   echo '[WSL] git fetch/pull'; \
   git fetch --all --prune; \
   git pull --ff-only || (echo '[WSL] git pull failed (non-ff). Resolve manually.' >&2; exit 2); \
   echo '[WSL] install deps'; \
   if [ -f package-lock.json ]; then npm ci; else npm install; fi; \
   echo '[WSL] restart systemd user service'; \
   systemctl --user daemon-reload; \
   systemctl --user restart '%SERVICE%'; \
   echo '[WSL] status:'; \
   systemctl --user status '%SERVICE%' --no-pager; \
   echo '[WSL] last logs:'; \
   journalctl --user -u '%SERVICE%' -n 50 --no-pager -o cat"

set "RC=%ERRORLEVEL%"
echo.
if NOT "%RC%"=="0" (
  echo [ERROR] Restart failed. ExitCode=%RC%
  exit /b %RC%
)

echo [OK] Codex Remote Bot restarted successfully.
exit /b 0