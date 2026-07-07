#!/bin/bash

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

find_bin() {
  local name="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  command -v "$name" 2>/dev/null || true
}

NODE_BIN="$(find_bin node \
  "$HOME/.local/bin/node" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node")"

CURL_BIN="$(find_bin curl /usr/bin/curl /opt/homebrew/bin/curl)"
OPEN_BIN="$(find_bin open /usr/bin/open)"
OSASCRIPT_BIN="$(find_bin osascript /usr/bin/osascript)"
LSOF_BIN="$(find_bin lsof /usr/sbin/lsof /usr/bin/lsof)"
KILL_BIN="$(find_bin kill /bin/kill)"
PGREP_BIN="$(find_bin pgrep /usr/bin/pgrep /opt/homebrew/bin/pgrep)"
LOG_FILE=""

log_msg() {
  [ -n "$LOG_FILE" ] && echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG_FILE"
}

notify_msg() {
  local text="$1"
  [ -n "$OSASCRIPT_BIN" ] && "$OSASCRIPT_BIN" -e "display notification \"$text\" with title \"Kiro-Codex\"" >/dev/null 2>&1 || true
}