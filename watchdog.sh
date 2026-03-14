#!/bin/bash
# watchdog.sh — Restart NanoClaw if it's not running or has a broken channel

PIDFILE="/home/amos/nanoclaw/nanoclaw.pid"
LOGFILE="/home/amos/nanoclaw/logs/nanoclaw.log"
ERRLOG="/home/amos/nanoclaw/logs/nanoclaw.error.log"

restart() {
  local reason="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $reason — restarting..." >> "$LOGFILE"
  bash /home/amos/nanoclaw/start-nanoclaw.sh >> "$LOGFILE" 2>&1
}

is_running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Check 1: process not running
if ! is_running; then
  restart "NanoClaw not running"
  exit 0
fi

# Check 2: token error in error log within the last 10 minutes
if [ -f "$ERRLOG" ]; then
  RECENT=$(find "$ERRLOG" -mmin -10 2>/dev/null)
  if [ -n "$RECENT" ] && tail -50 "$ERRLOG" | grep -q "Unable to introspect the access token"; then
    restart "Matrix token error detected"
    exit 0
  fi
fi
