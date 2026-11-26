#!/usr/bin/env bash
# Worker crash: kill (SIGKILL) the worker container that is processing a slow event and watch
# the other worker recover it once the lease expires. Restarts the killed worker at the end.
source "$(dirname "$0")/lib.sh"
require_stack

EVENT="evt_crash_$RUN_ID"

bold "Sending $EVENT with simulate=slow:20"
post_event "$EVENT" "ORD-5001" "slow:20"

owner=""
for _ in $(seq 1 30); do
  owner="$(sql_value "select coalesce(locked_by, '') from webhook_events where event_id = '$EVENT' and status = 'processing'")"
  [[ -n "$owner" ]] && break
  sleep 0.5
done
[[ -n "$owner" ]] || { echo "Event was not picked up by a worker" >&2; exit 1; }

container="$(docker compose --project-directory "$ROOT_DIR" ps -q "$owner")"
bold "$EVENT is being processed by $owner; running: docker kill $container"
sleep 2
docker kill "$container" > /dev/null
note "$owner killed at $(date -u +%T) UTC"

bold "Right after the kill: still 'processing', lease not expired yet"
sql_table "select event_id, status, locked_by, lease_expires_at - now() as lease_left
           from webhook_events where event_id = '$EVENT'"

note "waiting for the lease to expire and another worker to recover and finish it..."
wait_terminal 90 "$EVENT"

bold "Result"
show_events "$EVENT"
show_attempts "$EVENT"
show_processed "$EVENT"
note "Expected: attempt 1 by $owner 'abandoned' (lease expired), attempt 2 by the other worker 'succeeded', 1 row."

bold "Restarting $owner"
docker compose --project-directory "$ROOT_DIR" start "$owner" > /dev/null 2>&1
note "done"
