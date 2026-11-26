#!/usr/bin/env bash
# Permanent failure: always fails. Retries stop at MAX_ATTEMPTS and the event is marked failed.
# Then a manual retry gives it a fresh budget (attempt numbers keep counting up).
source "$(dirname "$0")/lib.sh"
require_stack

EVENT="evt_perm_$RUN_ID"

bold "Sending $EVENT with simulate=always_fail"
post_event "$EVENT" "ORD-3001" "always_fail"

note "waiting until the retry budget is used up..."
wait_terminal 120 "$EVENT"
show_events "$EVENT"
show_attempts "$EVENT"

before="$(sql_value "select attempt_count from webhook_events where event_id = '$EVENT'")"
note "waiting 10s to show no more attempts happen..."
sleep 10
after="$(sql_value "select attempt_count from webhook_events where event_id = '$EVENT'")"
note "attempts before: $before, after 10s: $after (retries stopped)"
show_processed "$EVENT"
note "Expected: status failed, attempts = MAX_ATTEMPTS (default 5), no processed_orders row."

bold "Manual retry: POST /events/$EVENT/retry"
curl -s -w ' %{http_code}\n' -X POST "$API_URL/events/$EVENT/retry"
wait_terminal 120 "$EVENT"
show_attempts "$EVENT"
note "Expected: a second round of attempts numbered from $((after + 1)), still failing (always_fail)."
