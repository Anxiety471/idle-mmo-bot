#!/usr/bin/env bash
set -euo pipefail
cd /workspace/idle-mmo-bot-pr

# Stop prior IdleBocchi autopilot node processes only
mapfile -t PIDS < <(pgrep -f '/workspace/idle-mmo-bot-pr/.*cli\.ts autopilot' || true)
for pid in "${PIDS[@]:-}"; do
  [[ -n "$pid" ]] || continue
  # Don't kill ourselves
  if [[ "$pid" -eq "$$" || "$pid" -eq "$PPID" ]]; then continue; fi
  echo "stopping pid=$pid"
  kill "$pid" 2>/dev/null || true
done
sleep 2

{
  echo "======== RESTART $(date '+%Y-%m-%dT%H:%M:%S%z') IdleBocchi headed autopilot DISPLAY=:3 no-Jev max+stance ========"
  echo "playbook=$(jq -c '{stage,huntBattles:.counts.huntBattles}' logs/playbook-state.json 2>/dev/null || echo unknown)"
  echo "========"
} > logs/bocchi-autopilot.out

set -a
# shellcheck disable=SC1091
source .env
# shellcheck disable=SC1091
source .env.bocchi.api
set +a

export HEADLESS=false
export DISPLAY=:3
export FORCE_INTERRUPT=true
export BUY_BAIT=true
export EARLY_PLAYBOOK=true
export POLL_MS=30000
export SELL_GOLD_THRESHOLD=800
export AUTOPILOT_LOG_DIR=./logs
export PLAYBOOK_STATE_PATH=./logs/playbook-state.json
export STORAGE_STATE=./storage-state.json

if [[ "${CHARACTER_NAME:-}" != "IdleBocchi" ]]; then
  echo "ERROR: CHARACTER_NAME must be IdleBocchi" >&2
  exit 1
fi

echo "env ok CHARACTER_NAME=IdleBocchi HEADLESS=$HEADLESS DISPLAY=$DISPLAY FORCE_INTERRUPT=$FORCE_INTERRUPT BUY_BAIT=$BUY_BAIT EARLY_PLAYBOOK=$EARLY_PLAYBOOK POLL_MS=$POLL_MS"

# Detach fully so this script can exit
nohup npx tsx src/cli.ts autopilot -v --interrupt >> logs/bocchi-autopilot.out 2>&1 &
APID=$!
echo "spawned_pid=$APID"
disown "$APID" 2>/dev/null || true
sleep 3
if kill -0 "$APID" 2>/dev/null; then
  echo "alive pid=$APID"
else
  echo "WARNING: pid $APID not alive after 3s" >&2
  # try to find child
  pgrep -af 'idle-mmo-bot-pr' | head -20 || true
fi
tail -n 25 logs/bocchi-autopilot.out
