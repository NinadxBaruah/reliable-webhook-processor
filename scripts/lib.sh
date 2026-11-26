#!/usr/bin/env bash
# Shared helpers for the demo scripts. Needs: bash, curl, docker compose (stack running).
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Unique suffix so every demo run uses fresh event ids.
RUN_ID="${RUN_ID:-$(date +%s)}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# psql inside the postgres container; extra args are passed through.
psql_q() {
  docker compose --project-directory "$ROOT_DIR" exec -T postgres \
    psql -U postgres -d webhooks -v ON_ERROR_STOP=1 "$@"
}

# Single value, no formatting.
sql_value() { psql_q -tA -c "$1"; }

# Pretty table.
sql_table() { psql_q -P pager=off -c "$1"; }

# post_event <eventId> <orderId> [simulate]  -> prints "<http code> <body>"
post_event() {
  local event_id="$1" order_id="$2" simulate="${3:-}"
  local data="{\"orderId\":\"$order_id\",\"customerId\":\"CUS-42\""
  [[ -n "$simulate" ]] && data+=",\"simulate\":\"$simulate\""
  data+="}"
  curl -s -w ' %{http_code}' -X POST "$API_URL/webhooks" \
    -H 'content-type: application/json' \
    -d "{\"eventId\":\"$event_id\",\"type\":\"order.created\",\"data\":$data}"
  echo
}

# in_list a b c -> 'a','b','c'
in_list() {
  local out="" id
  for id in "$@"; do out+="${out:+,}'$id'"; done
  echo "$out"
}

# wait_terminal <timeout seconds> <eventId>...
wait_terminal() {
  local timeout="$1"; shift
  local ids deadline open
  ids="$(in_list "$@")"
  deadline=$((SECONDS + timeout))
  while :; do
    open="$(sql_value "select count(*) from webhook_events where event_id in ($ids) and status in ('pending','processing')")"
    [[ "$open" == "0" ]] && return 0
    if (( SECONDS > deadline )); then
      echo "Timed out: $open event(s) still not terminal" >&2
      return 1
    fi
    sleep 1
  done
}

show_events() {
  sql_table "select event_id, status, attempt_count as attempts, delivery_count as deliveries,
                    coalesce(locked_by, '') as worker, coalesce(last_error, '') as last_error
             from webhook_events where event_id in ($(in_list "$@")) order by event_id"
}

show_attempts() {
  sql_table "select event_id, attempt_number as attempt, worker_id as worker, result,
                    to_char(started_at, 'HH24:MI:SS.MS') as started,
                    to_char(finished_at, 'HH24:MI:SS.MS') as finished,
                    coalesce(error, '') as error
             from event_attempts where event_id in ($(in_list "$@"))
             order by event_id, attempt_number"
}

show_processed() {
  sql_table "select event_id, count(*) as processed_orders_rows from processed_orders
             where event_id in ($(in_list "$@")) group by event_id order by event_id"
}

require_stack() {
  if ! curl -sf "$API_URL/health" > /dev/null; then
    echo "API not reachable at $API_URL. Start the stack first: docker compose up -d" >&2
    exit 1
  fi
}
