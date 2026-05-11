#!/usr/bin/env bash
# Запуск iwe-local-gateway daemon.
# Использование: bash scripts/start-daemon.sh [--restart]
# Вызывать один раз при открытии VS Code / начале multi-agent сессии.

set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$HOME/.iwe/gateway.pid"
SOCKET_FILE="$HOME/.iwe/gateway.sock"
DAEMON="$GATEWAY_DIR/dist/daemon.js"

if [[ ! -f "$DAEMON" ]]; then
  echo "[start-daemon] daemon not built. Run: cd $GATEWAY_DIR && npm run build"
  exit 1
fi

# --restart: kill existing daemon first
if [[ "${1:-}" == "--restart" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null && echo "[start-daemon] stopped old daemon pid=$PID" || true
    rm -f "$PID_FILE" "$SOCKET_FILE"
  fi
fi

# Check if daemon is already running
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "[start-daemon] daemon already running pid=$PID socket=$SOCKET_FILE"
    exit 0
  fi
  rm -f "$PID_FILE" "$SOCKET_FILE"
fi

nohup node "$DAEMON" >> "$HOME/.iwe/gateway.log" 2>&1 &
echo "[start-daemon] started pid=$! socket=$SOCKET_FILE"
