#!/usr/bin/env bash
# Temporary failure: fails its first 2 attempts, then succeeds after backoff.
source "$(dirname "$0")/lib.sh"
require_stack

EVENT="evt_temp_$RUN_ID"

bold "Sending $EVENT with simulate=fail_then_succeed:2"
post_event "$EVENT" "ORD-2001" "fail_then_succeed:2"

note "waiting for retries (backoff grows each attempt)..."
wait_terminal 60 "$EVENT"

bold "Result"
show_events "$EVENT"
show_attempts "$EVENT"
show_processed "$EVENT"
note "Expected: attempts 1-2 failed, attempt 3 succeeded, growing gaps between attempts, 1 row."
