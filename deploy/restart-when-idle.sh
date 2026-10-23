#!/usr/bin/env bash
# Restart ccpocket-bridge only when no session would be cut off.
#
# Claude sessions run as child processes of the bridge, so `systemctl restart`
# kills every running turn and every background subagent with it. This script
# polls the bridge's authorized /health (field `busy`) and restarts once it has
# been empty for two checks in a row.
#
#   deploy/restart-when-idle.sh            # wait as long as needed
#   deploy/restart-when-idle.sh --max-wait 1800   # give up after 30 min
#   deploy/restart-when-idle.sh --force    # old bridge without `busy`: restart anyway
set -euo pipefail

ENV_FILE=${CCPOCKET_ENV_FILE:-/etc/ccpocket-bridge.env}
SERVICE=${CCPOCKET_SERVICE:-ccpocket-bridge}
INTERVAL=10
MAX_WAIT=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --max-wait) MAX_WAIT=$2; shift 2 ;;
    --interval) INTERVAL=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
URL="http://${BRIDGE_HOST:-127.0.0.1}:${BRIDGE_PORT:-8765}/health"

# Prints the number of busy sessions (or "unknown" for a bridge without the
# field) followed by one line per busy session.
check() {
  curl -fsS --max-time 10 -H "Authorization: Bearer ${BRIDGE_API_KEY:-}" "$URL" |
    node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        const h = JSON.parse(raw);
        if (!Array.isArray(h.busy)) { console.log("unknown"); return; }
        console.log(h.busy.length);
        for (const s of h.busy) {
          const what = [s.status, s.backgroundWork ? "background tasks" : ""].filter(Boolean).join(", ");
          console.log(`  ${s.name || s.claudeSessionId || s.id}  ${s.projectPath}  (${what})`);
        }
      });'
}

start=$(date +%s)
quiet=0
last_report=0
while :; do
  if ! out=$(check); then
    echo "bridge not answering on $URL; restarting"
    break
  fi
  count=$(head -n1 <<<"$out")
  if [ "$count" = "unknown" ]; then
    if [ "$FORCE" = 1 ]; then echo "bridge does not report busy sessions; --force given"; break; fi
    echo "bridge does not report busy sessions (older build); check by hand or pass --force" >&2
    exit 2
  fi
  if [ "$count" = 0 ]; then
    quiet=$((quiet + 1))
    [ "$quiet" -ge 2 ] && break
  else
    quiet=0
    now=$(date +%s)
    if [ $((now - last_report)) -ge 60 ]; then
      echo "$(date +%T) waiting for $count busy session(s):"
      tail -n +2 <<<"$out"
      last_report=$now
    fi
    if [ "$MAX_WAIT" -gt 0 ] && [ $((now - start)) -ge "$MAX_WAIT" ]; then
      echo "still busy after ${MAX_WAIT}s; not restarting" >&2
      exit 1
    fi
  fi
  sleep "$INTERVAL"
done

systemctl restart "$SERVICE"
echo "$(date +%T) $SERVICE restarted"
