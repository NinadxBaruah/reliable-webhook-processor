#!/usr/bin/env bash
# Burst: 500 events submitted at once. Shows the API keeps answering quickly and every event
# reaches a terminal state. The load generator (backend/scripts/burst.ts) runs in a container,
# so this works the same on any OS. Mix: 80% ok, 10% fail_then_succeed:1, 5% slow:2,
# 5% always_fail.
source "$(dirname "$0")/lib.sh"
require_stack

TOTAL="${TOTAL:-500}"
PREFIX="evt_burst_${RUN_ID}_"

bold "Submitting $TOTAL events at once"
docker compose --project-directory "$ROOT_DIR" --profile tools run --rm \
  -e TOTAL="$TOTAL" -e PREFIX="$PREFIX" burst

bold "API responsiveness while the workers drain the queue"
for _ in 1 2 3; do
  note "GET /health took $(curl -s -o /dev/null -w '%{time_total}' "$API_URL/health")s"
  sleep 1
done

bold "Waiting for all $TOTAL events to reach a terminal state"
deadline=$((SECONDS + 180))
while :; do
  open="$(sql_value "select count(*) from webhook_events where event_id like '${PREFIX}%' and status in ('pending','processing')")"
  note "$(date -u +%T) UTC still open: $open"
  [[ "$open" == "0" ]] && break
  (( SECONDS > deadline )) && { echo "Timed out" >&2; exit 1; }
  sleep 2
done

bold "Result"
sql_table "select status, count(*) from webhook_events where event_id like '${PREFIX}%'
           group by status order by status"
sql_table "select count(*) as processed_orders_rows, count(distinct event_id) as distinct_events
           from processed_orders where event_id like '${PREFIX}%'"
sql_table "select worker_id, count(*) as attempts from event_attempts
           where event_id like '${PREFIX}%' group by worker_id order by worker_id"
note "Expected: $TOTAL events, all succeeded or failed (5% always_fail), one processed_orders row per succeeded event."
