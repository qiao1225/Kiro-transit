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

mkdir -p "$API_ROOT/data"

resolve_env_file() {
  if [ -f "$API_ROOT/.env" ]; then
    echo "$API_ROOT/.env"
  elif [ -f "$PROJECT_ROOT/.env" ]; then
    echo "$PROJECT_ROOT/.env"
  else
    echo ""
  fi
}

is_web_running() {
  [ -n "$LSOF_BIN" ] && "$LSOF_BIN" -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

start_web_server() {
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    notify_msg "未找到 Node，请安装 Node.js"
    log_msg "node not found"
    return 1
  fi

  cd "$API_ROOT"
  nohup "$NODE_BIN" server.mjs >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  log_msg "web server started pid=$!"

  if [ -n "$CURL_BIN" ]; then
    for _ in $(seq 1 30); do
      if "$CURL_BIN" -fsS "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.2
    done
  else
    sleep 1
  fi

  if is_web_running; then
    return 0
  fi

  notify_msg "网页服务启动失败，请查看 service.log"
  log_msg "web server failed to listen on $PORT"
  return 1
}

gateway_health_ok() {
  [ -n "$CURL_BIN" ] && "$CURL_BIN" -fsS "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1
}

start_native_gateway() {
  local env_file="$1"

  if gateway_health_ok; then
    log_msg "gateway already running"
    return 0
  fi

  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    log_msg "node not found, cannot start native gateway"
    return 1
  fi

  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    set -a; source "$env_file"; set +a
  fi

  cd "$API_ROOT"
  nohup "$NODE_BIN" native-gateway.mjs >>"$LOG_FILE" 2>&1 &
  echo $! >"$GATEWAY_PID_FILE"
  log_msg "native gateway started pid=$!"

  if [ -n "$CURL_BIN" ]; then
    for _ in $(seq 1 40); do
      if gateway_health_ok; then
        log_msg "native gateway ready"
        return 0
      fi
      sleep 0.25
    done
  else
    sleep 1
    if gateway_health_ok; then
      return 0
    fi
  fi

  log_msg "native gateway start timeout"
  return 1
}

start_gateway() {
  start_native_gateway "$1"
}

log_msg "start requested"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(tr -d '[:space:]' <"$PID_FILE")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    notify_msg "服务已在运行"
    [ -n "$OPEN_BIN" ] && "$OPEN_BIN" "http://127.0.0.1:${PORT}"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if is_web_running; then
  /bin/bash "$API_ROOT/scripts/background-stop.sh" >>"$LOG_FILE" 2>&1 || true
fi

ENV_FILE="$(resolve_env_file)"
if [ -z "$ENV_FILE" ]; then
  if [ -n "$NODE_BIN" ]; then
    cd "$API_ROOT"
    "$NODE_BIN" scripts/setup.mjs >>"$LOG_FILE" 2>&1
    ENV_FILE="$API_ROOT/.env"
  fi
fi

GATEWAY_OK=0
if start_gateway "$ENV_FILE"; then
  GATEWAY_OK=1
fi

if ! start_web_server; then
  exit 1
fi

[ -n "$OPEN_BIN" ] && "$OPEN_BIN" "http://127.0.0.1:${PORT}"

if [ "$GATEWAY_OK" -eq 1 ]; then
  notify_msg "本地代理和网页已启动（Node 原生模式）"
  log_msg "start completed with native gateway"
else
  notify_msg "网页已启动；Kiro Gateway 未启动，请检查凭据"
  log_msg "start completed without gateway"
fi