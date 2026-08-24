#!/bin/sh

set -u

APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONFIGURED_DATA_DIRECTORY=${AFU_DATA_DIR:-${LOCALRSS_DATA_DIR:-}}
if [ -n "$CONFIGURED_DATA_DIRECTORY" ]; then
  case "$CONFIGURED_DATA_DIRECTORY" in
    /*) STATE_DIRECTORY=$CONFIGURED_DATA_DIRECTORY ;;
    *) STATE_DIRECTORY="$APP_ROOT/$CONFIGURED_DATA_DIRECTORY" ;;
  esac
else
  STATE_DIRECTORY="$APP_ROOT/data"
fi
PID_FILE="$STATE_DIRECTORY/afu-macos.pid"
TOKEN_FILE="$STATE_DIRECTORY/afu-macos.token"
LOG_FILE="$STATE_DIRECTORY/afu-macos.log"
APP_PORT=${PORT:-43110}
APP_URL="http://127.0.0.1:$APP_PORT"

show_error() {
  message=$1
  printf '%s\n' "$message" >&2
  if command -v osascript >/dev/null 2>&1; then
    osascript - "$message" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display alert "ArxivFollowUp" message (item 1 of argv) as critical
end run
APPLESCRIPT
  fi
}

node_major_version() {
  "$1" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null
}

find_node() {
  path_node=$(command -v node 2>/dev/null || true)
  for candidate in \
    "${AFU_NODE_PATH:-}" \
    "$path_node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node"
  do
    if [ -x "$candidate" ]; then
      major=$(node_major_version "$candidate")
      if [ -n "$major" ] && [ "$major" -ge 24 ] 2>/dev/null; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  done

  for candidate in \
    "$HOME"/.nvm/versions/node/v*/bin/node \
    "$HOME"/.fnm/node-versions/v*/installation/bin/node
  do
    if [ -x "$candidate" ]; then
      major=$(node_major_version "$candidate")
      if [ -n "$major" ] && [ "$major" -ge 24 ] 2>/dev/null; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  done

  return 1
}

fetch_bootstrap() {
  curl --silent --show-error --fail --max-time 2 "$APP_URL/api/bootstrap" 2>/dev/null
}

open_app() {
  open "$APP_URL" >/dev/null 2>&1 || true
}

is_our_process() {
  process_id=$1
  command_line=$(ps -p "$process_id" -o command= 2>/dev/null || true)
  case "$command_line" in
    *"$APP_ROOT/src/server.js"*) return 0 ;;
    *) return 1 ;;
  esac
}

clean_state() {
  rm -f -- "$PID_FILE" "$TOKEN_FILE"
}

start_service() {
  if ! cd "$APP_ROOT"; then
    show_error "Cannot open the project directory at $APP_ROOT."
    return 1
  fi

  bootstrap=$(fetch_bootstrap || true)
  if [ -n "$bootstrap" ]; then
    open_app
    printf 'ArxivFollowUp is already running at %s\n' "$APP_URL"
    return 0
  fi

  if [ -f "$PID_FILE" ]; then
    previous_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null || true)
    if [ -n "$previous_pid" ] && kill -0 "$previous_pid" 2>/dev/null; then
      show_error "ArxivFollowUp process $previous_pid is running but did not answer at $APP_URL. See $LOG_FILE for details."
      return 1
    fi
    clean_state
  fi

  if curl --silent --max-time 1 "$APP_URL/" >/dev/null 2>&1; then
    show_error "Port $APP_PORT is already in use by another application. Set PORT to a free port before starting ArxivFollowUp."
    return 1
  fi

  NODE_BINARY=$(find_node || true)
  if [ -z "$NODE_BINARY" ]; then
    show_error "Node.js 24 or newer is required. Install it from https://nodejs.org/ and try again."
    return 1
  fi

  if [ ! -f "$APP_ROOT/node_modules/fast-xml-parser/package.json" ]; then
    show_error "Project dependencies are not installed. Open Terminal in $APP_ROOT, run npm ci once, and then try again."
    return 1
  fi

  if ! mkdir -p "$STATE_DIRECTORY"; then
    show_error "Cannot create the data directory at $STATE_DIRECTORY."
    return 1
  fi
  tray_token=$(uuidgen 2>/dev/null | tr -d '-' | tr '[:upper:]' '[:lower:]')
  if [ -z "$tray_token" ]; then
    tray_token="afu-$(date +%s)-$$"
  fi

  AFU_TRAY_TOKEN=$tray_token nohup "$NODE_BINARY" "$APP_ROOT/src/server.js" >>"$LOG_FILE" 2>&1 </dev/null &
  server_pid=$!
  printf '%s\n' "$server_pid" >"$PID_FILE"
  printf '%s\n' "$tray_token" >"$TOKEN_FILE"
  chmod 600 "$PID_FILE" "$TOKEN_FILE" 2>/dev/null || true

  attempt=0
  while [ "$attempt" -lt 60 ]; do
    bootstrap=$(fetch_bootstrap || true)
    if [ -n "$bootstrap" ]; then
      if printf '%s' "$bootstrap" | "$NODE_BINARY" -e "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>process.exit(JSON.parse(input).settings.open_browser_on_start==='0'?1:0));"; then
        open_app
      fi
      printf 'ArxivFollowUp is running at %s\nLog: %s\n' "$APP_URL" "$LOG_FILE"
      return 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      clean_state
      show_error "ArxivFollowUp exited before it became ready. See $LOG_FILE for details."
      return 1
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done

  show_error "ArxivFollowUp did not become ready within 15 seconds. See $LOG_FILE for details."
  return 1
}

stop_service() {
  if [ ! -f "$PID_FILE" ]; then
    if fetch_bootstrap >/dev/null 2>&1; then
      show_error "ArxivFollowUp is running, but it was not started by the macOS launcher. Stop it from the terminal where it was started."
      return 1
    fi
    printf 'ArxivFollowUp is not running.\n'
    return 0
  fi

  server_pid=$(sed -n '1p' "$PID_FILE" 2>/dev/null || true)
  if [ -z "$server_pid" ] || ! kill -0 "$server_pid" 2>/dev/null; then
    clean_state
    printf 'ArxivFollowUp is not running.\n'
    return 0
  fi

  if ! is_our_process "$server_pid"; then
    show_error "The saved process ID no longer belongs to ArxivFollowUp. No process was stopped."
    clean_state
    return 1
  fi

  tray_token=$(sed -n '1p' "$TOKEN_FILE" 2>/dev/null || true)
  if [ -n "$tray_token" ]; then
    curl --silent --max-time 2 \
      --request POST \
      --header 'Content-Type: application/json' \
      --header 'X-AFU-Request: 1' \
      --header "X-AFU-Tray-Token: $tray_token" \
      --data '{}' \
      "$APP_URL/api/runtime/shutdown" >/dev/null 2>&1 || true
  fi

  attempt=0
  while kill -0 "$server_pid" 2>/dev/null && [ "$attempt" -lt 20 ]; do
    sleep 0.25
    attempt=$((attempt + 1))
  done

  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    attempt=0
    while kill -0 "$server_pid" 2>/dev/null && [ "$attempt" -lt 20 ]; do
      sleep 0.25
      attempt=$((attempt + 1))
    done
  fi

  if kill -0 "$server_pid" 2>/dev/null; then
    show_error "ArxivFollowUp did not stop. Process ID: $server_pid"
    return 1
  fi

  clean_state
  printf 'ArxivFollowUp has stopped.\n'
}

if [ "$(uname -s)" != 'Darwin' ]; then
  printf 'This launcher is intended for macOS.\n' >&2
  exit 1
fi

case "${1:-start}" in
  start) start_service ;;
  stop) stop_service ;;
  *) printf 'Usage: %s {start|stop}\n' "$0" >&2; exit 2 ;;
esac
