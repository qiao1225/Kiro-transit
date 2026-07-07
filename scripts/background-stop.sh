#!/bin/bash

API_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$API_ROOT/.." && pwd)"
# shellcheck source=lib/paths.sh
source "$API_ROOT/scripts/lib/paths.sh"

PID_FILE="$API_ROOT/data/service.pid"
GATEWAY_PID_FILE="$API_ROOT/data/gateway.pid"
LOG_FILE="$API_ROOT/data/service.log"
PORT=3920
GATEWAY_PORT=8000

log_msg "stop requested"
stopped=0

kill_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 0
  [ -n "$KILL_BIN" ] && "$KILL_BIN" "$pid" >/dev/null 2>&1 || true
  sleep 0.4
  if kill -0 "$pid" 2>/dev/null; then
    [ -n "$KILL_BIN" ] && "$KILL_BIN" -9 "$pid" >/dev/null 2>&1 || true
  fi
  ! kill -0 "$pid" 2>/dev/null
}

kill_port() {
  local port="$1"
  [ -n "$LSOF_BIN" ] || return 1
  local pids
  pids="$("$LSOF_BIN" -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] || return 1
  echo "$pids" | while read -r pid; do
    [ -n "$pid" ] && kill_pid "$pid"
  done
  ! "$LSOF_BIN" -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

if [ -f "$PID_FILE" ]; then
  PID="$(tr -d '[:space:]' <"$PID_FILE")"
  if [ -n "$PID" ] && kill_pid "$PID"; then
    stopped=1
    log_msg "stopped pid $PID"
  fi
  rm -f "$PID_FILE"
fi

if [ -n "$PGREP_BIN" ] && [ -n "$NODE_BIN" ]; then
  "$PGREP_BIN" -f "$API_ROOT/server.mjs" 2>/dev/null | while read -r pid; do
    if kill_pid "$pid"; then
      stopped=1
      log_msg "stopped server.mjs pid $pid"
    fi
  done
fi

if kill_port "$PORT"; then
  stopped=1
  log_msg "stopped web port $PORT"
fi

if [ -n "$LSOF_BIN" ] && "$LSOF_BIN" -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  "$LSOF_BIN" -tiTCP:"$PORT" -sTCP:LISTEN | while read -r pid; do
    [ -n "$KILL_BIN" ] && "$KILL_BIN" -9 "$pid" >/dev/null 2>&1 || true
  done
  stopped=1
  log_msg "force killed web port $PORT"
fi

if [ -f "$GATEWAY_PID_FILE" ]; then
  GPID="$(tr -d '[:space:]' <"$GATEWAY_PID_FILE")"
  if [ -n "$GPID" ] && kill_pid "$GPID"; then
    stopped=1
    log_msg "stopped native gateway pid $GPID"
  fi
  rm -f "$GATEWAY_PID_FILE"
fi

if [ -n "$PGREP_BIN" ] && [ -n "$NODE_BIN" ]; then
  "$PGREP_BIN" -f "$API_ROOT/native-gateway.mjs" 2>/dev/null | while read -r pid; do
    if kill_pid "$pid"; then
      stopped=1
      log_msg "stopped native-gateway.mjs pid $pid"
    fi
  done
fi

if kill_port "$GATEWAY_PORT"; then
  stopped=1
  log_msg "stopped gateway port $GATEWAY_PORT"
fi

if [ -n "$LSOF_BIN" ] && "$LSOF_BIN" -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  notify_msg "暂停失败：网页端口仍占用"
  log_msg "stop failed"
  exit 1
fi

if [ "$stopped" -eq 1 ]; then
  notify_msg "本地代理和网页已暂停"
  log_msg "stop completed"
else
  notify_msg "未发现运行中的服务"
  log_msg "stop completed, nothing running"
fi