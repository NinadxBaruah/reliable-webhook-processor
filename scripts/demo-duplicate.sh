#!/usr/bin/env bash
# Duplicate event: one eventId delivered many times, 20 of them at the same moment,
# plus one redelivery with a different payload. Expect exactly one processed_orders row.
source "$(dirname "$0")/lib.sh"
require_stack

EVENT="evt_dup_$RUN_ID"

bold "1. First delivery of $EVENT"
post_event "$EVENT" "ORD-1001"

bold "2. 20 simultaneous redeliveries"
pids=()
for _ in $(seq 1 20); do
  post_event "$EVENT" "ORD-1001" > /dev/null &
  pids+=($!)
done
wait "${pids[@]}"
note "all 20 answered"

bold "3. Redelivery with a different payload (ignored, first payload kept)"
post_event "$EVENT" "ORD-SOMETHING-ELSE"

wait_terminal 30 "$EVENT"

bold "Result"
show_events "$EVENT"
sql_table "select event_id, payload->'data'->>'orderId' as stored_order_id,
                  delivery_count, conflicting_delivery_count
           from webhook_events where event_id = '$EVENT'"
show_processed "$EVENT"
note "Expected: 22 deliveries, 1 conflicting, stored order ORD-1001, exactly 1 processed_orders row."
