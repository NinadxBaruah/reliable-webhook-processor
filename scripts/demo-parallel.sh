#!/usr/bin/env bash
# Parallel processing: 8 slow events, shared by both worker containers at the same time.
source "$(dirname "$0")/lib.sh"
require_stack

COUNT=8
SECONDS_EACH=5
ids=()
bold "Sending $COUNT events with simulate=slow:$SECONDS_EACH"
for i in $(seq 1 "$COUNT"); do
  id="evt_par_${RUN_ID}_$i"
  ids+=("$id")
  post_event "$id" "ORD-40$i" "slow:$SECONDS_EACH" > /dev/null
done
note "sent ${ids[*]}"

sleep 2
bold "While they run: who is processing what"
sql_table "select event_id, status, locked_by as worker from webhook_events
           where event_id in ($(in_list "${ids[@]}")) order by event_id"

wait_terminal 60 "${ids[@]}"

bold "Result"
show_attempts "${ids[@]}"
sql_table "select worker_id as worker, count(*) as events,
                  to_char(min(started_at), 'HH24:MI:SS.MS') as first_start,
                  to_char(max(finished_at), 'HH24:MI:SS.MS') as last_finish
           from event_attempts where event_id in ($(in_list "${ids[@]}"))
           group by worker_id order by worker_id"
note "Expected: both workers busy at once; $COUNT x ${SECONDS_EACH}s of work finishes in about ${SECONDS_EACH}s, not $((COUNT * SECONDS_EACH))s."
