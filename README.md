# Reliable Webhook Processor

Receives webhook events, stores them, and processes them with background workers. Each event's
business row is written exactly once, even with duplicate deliveries, failures, retries and
workers killed mid-event.

**Stack:** TypeScript everywhere · NestJS (API + workers) · Next.js (operations page) · PostgreSQL
(storage and queue).

## Quick start

Requirements: Docker with Compose v2.

```bash
docker compose up --build
```

This starts PostgreSQL, a one-shot migration, the API, **two worker containers** and the
frontend. The first build takes a minute or two.

| What | Where |
|---|---|
| API (`POST /webhooks`) | http://localhost:3000 |
| Operations page | http://localhost:3001 |
| PostgreSQL | `localhost:55432` (user/password `postgres`, db `webhooks`) |

Host ports and tunables (retries, backoff, lease, concurrency) can be overridden through
environment variables. See [`.env.example`](.env.example). No other setup is needed.

```bash
curl -i -X POST http://localhost:3000/webhooks -H 'content-type: application/json' \
  -d '{"eventId":"evt_123","type":"order.created","data":{"orderId":"ORD-1001","customerId":"CUS-42","simulate":"fail_then_succeed:2"}}'
```

## Demonstration scenarios

Each script uses fresh event ids, so it can be re-run, and prints the evidence straight from
PostgreSQL. They need `bash`, `curl` and the running stack (on Windows: Git Bash or WSL).

| Scenario | Command | What you should see |
|---|---|---|
| Duplicate event | `./scripts/demo-duplicate.sh` | 22 deliveries (20 simultaneous, 1 with a different payload), first payload kept, **1** `processed_orders` row |
| Temporary failure | `./scripts/demo-temporary-failure.sh` | attempts 1–2 failed, 3 succeeded, growing gaps between attempts |
| Permanent failure | `./scripts/demo-permanent-failure.sh` | stops at 5 attempts, `failed`, no new attempts afterwards; then a manual retry runs attempts 6–10 |
| Parallel processing | `./scripts/demo-parallel.sh` | 8 × `slow:5` shared by `worker-1` and `worker-2`, all done in ~5 s instead of 40 s |
| Worker crash | `./scripts/demo-crash.sh` | `docker kill` on the worker holding a `slow:20` event; after the lease expires the other worker finishes it; attempt 1 `abandoned`, attempt 2 `succeeded`, **1** row |
| Burst (stretch) | `./scripts/demo-burst.sh` | 500 events at once all answered `202` (~1.3 s), `/health` stays fast, every event ends `succeeded` or `failed` |

To kill a worker by hand: find its owner on the ops page (or in `webhook_events.locked_by`),
then run `docker kill webhook-processor-worker-1-1` (or `-worker-2-1`). Bring it back with
`docker compose start worker-1`.

## Architecture

```
            POST /webhooks                       INSERT … ON CONFLICT (event_id)
 sender ───────────────────▶  API (NestJS)  ───────────────────────────────────▶  webhook_events
                      ◀─── 202 after commit                                         (pending)
                                                                                        │
 ┌─────────────────────────── worker-1, worker-2 (NestJS, 4 slots each) ───────────────┴───┐
 │ claim     one statement: SELECT … FOR UPDATE SKIP LOCKED → status=processing,          │
 │           attempt_count+1, lease token + expiry, open event_attempts row               │
 │ work      run data.simulate; heartbeat renews the lease every HEARTBEAT_MS             │
 │ success   ONE transaction: re-check lease (row lock) → INSERT processed_orders →       │
 │           status=succeeded → attempt succeeded                                          │
 │ failure   status=pending with backoff, or failed when the budget is used up            │
 │ recovery  any worker: processing + expired lease → pending (or failed), attempt        │
 │           marked abandoned                                                             │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
 Next.js ops page ──(same-origin /api proxy)──▶ API  GET /events, /events/:id, POST /events/:id/retry
```

**Event states**

```
pending ──claim──▶ processing ──success──▶ succeeded
   ▲                  │  │
   └──retry/backoff───┘  └──budget used up / non-retryable──▶ failed ──manual retry──▶ pending
   ▲                  │
   └──lease expired (worker died)
```

**Tables** (`backend/src/database/migrations/0001_initial_schema.ts`)

- `webhook_events`: one row per `eventId` (primary key). Holds the first payload, the queue
  state (`status`, `attempt_count`, `budget_start_attempt`, `next_attempt_at`), the lease
  (`locked_by`, `lease_token`, `lease_expires_at`), `last_error` and delivery counters. CHECK
  constraints keep the state consistent: a `processing` row must have a lease, and the budget
  start can't exceed the attempt count.
- `processed_orders(order_id, event_id, processed_at)`: the business record.
  **`event_id` is the primary key.**
- `event_attempts`: one row per attempt (event, attempt number, worker, start, finish, result
  `running | succeeded | failed | abandoned`, error). Unique on `(event_id, attempt_number)`.

**How workers coordinate.** Only through PostgreSQL; workers never talk to each other.

- **Claiming.** `FOR UPDATE SKIP LOCKED` lets concurrent claimers take different rows without
  blocking each other. A row is claimable only while `pending`.
- **Ownership.** A claim gives the worker a random lease token and an expiry. The worker
  renews the lease while it works. Every later write (complete, fail, renew) matches on that
  token, so a worker that lost the event cannot change it.
- **Clock.** All times (leases, backoff, recovery) come from the database clock, so clock
  drift between containers doesn't matter.

## Key libraries

| Library | Why |
|---|---|
| **Kysely** + `pg` | Type-safe query builder that still lets me write the exact SQL this needs (`FOR UPDATE SKIP LOCKED`, data-modifying CTEs, `ON CONFLICT`), with built-in migrations. ORMs like Prisma or TypeORM hide that SQL, and Prisma has no `SKIP LOCKED` outside raw queries. |
| **No queue library** (pg-boss / BullMQ) | BullMQ keeps queue state in Redis, separate from the business write: a dual write that can disagree after a crash. pg-boss would work, but the claim/complete logic is about 150 lines of SQL here, and keeping it explicit lets the success path share one transaction with the business row. |
| `@nestjs/config` + **zod** | Env vars checked once at startup; a bad value stops the process instead of breaking processing later. |
| `class-validator` / `class-transformer` | The standard NestJS way to validate request bodies and query strings. |
| **nestjs-pino** | Structured JSON logs carrying `eventId` and attempt, tagged per service. |
| Jest + ts-jest + supertest | NestJS defaults. Integration tests run against real PostgreSQL. |
| Next.js 16 / React 19 | Required. A client component polls the API through a same-origin route handler. |

## Correctness guarantees

| Guarantee | Why it holds | Proven by |
|---|---|---|
| An event is stored before it is acknowledged | `202` is sent only after the `INSERT` has committed | `ingestion.e2e.spec.ts` |
| Duplicate deliveries, even simultaneous, create one event; the first payload wins | Primary key on `event_id` + a single `INSERT … ON CONFLICT DO UPDATE` that only bumps counters, never the payload or state | `ingestion.e2e.spec.ts` (50 simultaneous; conflicting payloads) |
| **At most one `processed_orders` row per event** | The row is inserted in the same transaction that row-locks the event, checks the lease token and sets `succeeded`. `event_id` is also the primary key (`ON CONFLICT DO NOTHING`) as a final guard | `worker-concurrency.spec.ts`, `crash-recovery.spec.ts` |
| Two live workers never process the same event at once | Claim is one statement (`SKIP LOCKED` + `pending` → `processing`). A lease is only taken over once it has expired, and live workers renew theirs | `worker-concurrency.spec.ts` (10 simultaneous claimers; 4 workers × 150 events × 3 deliveries; attempts never overlap); `crash-recovery.spec.ts` (work 4× longer than the lease is not stolen) |
| Retries are bounded and back off | Backoff is exponential with jitter (`next_attempt_at`). After `MAX_ATTEMPTS` in the current budget, or on a non-retryable error, the event becomes `failed` | `retries.spec.ts` |
| A dead worker's event is picked up again; nothing stays in `processing` forever | Every worker regularly moves expired-lease rows back to `pending` (or `failed` if that was the last allowed attempt) and marks the dead attempt `abandoned` | `crash-recovery.spec.ts`, `demo-crash.sh` |
| Recovery never adds a second business row | A crash before commit rolls back both the business row and `succeeded`. A crash after commit leaves the event `succeeded`, so it isn't recovered. Even a business row forced in before the crash (a test-only scenario) is not duplicated | `crash-recovery.spec.ts` |
| A worker that comes back after losing its lease (frozen, partitioned) changes nothing | Writes are fenced by the lease token: complete throws `LeaseLostError`, fail and renew return nothing | `crash-recovery.spec.ts` |
| Manual retry gives a fresh budget; attempt numbers keep growing | `budget_start_attempt = attempt_count`; the `status = 'failed'` check is inside the `UPDATE`, so two simultaneous retries can't both apply | `retries.spec.ts` |
| `simulate` holds for awkward values | Any `fail_then_succeed:N` (above the cap: fails into `failed`, then a manual retry continues counting) and any `slow:N` (longer than the lease, thanks to heartbeats; longer than 24.8 days by chunking Node timers) | `simulation.spec.ts`, `crash-recovery.spec.ts` |

## Known limitations

- **Only the database write is exactly-once; the downstream call is not.** If a worker dies
  after the (simulated) downstream call but before its commit, the next attempt makes the call
  again. A real downstream API would need `eventId` as an idempotency key (see next steps).
- **A frozen or cut-off worker can overlap with its replacement for a while.** If a worker is
  paused (GC, `docker pause`) or loses the database for longer than `LEASE_MS`, another worker
  takes the event while the first may still be running its simulated work. The first worker's
  writes are rejected by the lease token, and it aborts on its own once it fails to renew past
  its local lease estimate. A paused process can't abort itself; its writes are refused when it
  wakes.
- **Recovery is not instant.** A killed worker's events wait up to `LEASE_MS` +
  `RECOVERY_INTERVAL_MS` (about 12 s with the compose defaults) before another worker picks
  them up.
- **Crashes use up attempts.** An abandoned attempt counts against the budget, so an event
  whose worker is killed `MAX_ATTEMPTS` times (e.g. a long `slow:N` during repeated restarts)
  ends `failed`. That is deliberate, so a poison message can't loop forever, but it also hits
  innocent events.
- **Slow events block slots.** Each worker has `WORKER_CONCURRENCY` slots (4). Eight concurrent
  `slow:3600` events hold all 8 slots for an hour and nothing else gets processed. There is no
  per-event execution timeout.
- **Graceful stop.** On `docker stop`, in-flight events get `SHUTDOWN_GRACE_MS` (10 s). After
  that they are aborted but not released; they wait for their lease to expire like a crash.
- **Polling.** Idle workers poll every 500 ms, so pickup can lag up to 500 ms and an idle
  system still runs a cheap indexed query per worker twice a second.
- **Burst latency comes from connection pools.** With 500 simultaneous requests the API's
  10-connection pool queues them: all are answered with `202`, but at p50 ~0.7 s, p99 ~1.1 s.
- **Storage grows forever.** `webhook_events` and `event_attempts` are never pruned or
  partitioned.
- **Stored payload.** The stored payload is the validated `{eventId, type, data}`; unknown
  top-level fields are dropped. "Different payload" means different JSON values, not different
  bytes.
- The ops page shows the 200 most recent events (filterable by status) without paging.

## Decisions (where the brief was open)

- **PostgreSQL as the queue, no Redis.** The event, its queue state and the business row live
  in one database, so "do the work" and "mark it done" can be one ACID transaction. That is
  the core of the duplicate and crash guarantees. The trade-off is lower throughput than a
  dedicated broker, plus polling. Both are fine at this scale.
- **Leases with heartbeats and fencing tokens**, rather than holding a row lock or a
  transaction open during processing. Long transactions would hold a pool connection per
  in-flight event for the length of `slow:N` and hide ownership. A visible lease shows who
  owns what on the ops page, and a dead worker is detected by time alone.
- **A different payload for a known `eventId`** gets `202`, is ignored, and is logged and
  counted (`conflicting_delivery_count`). Rejecting it would make senders retry forever.
- **Ingestion is schema-light.** The API checks `eventId`, `type` and that `data` is an object.
  A missing `orderId` or an unknown `simulate` value is still accepted, then fails at
  processing as **non-retryable** (straight to `failed`, visible on the ops page), because it
  can never succeed.
- **`simulate` parsing is lenient:** case-insensitive and trimmed, `slow:N` accepts decimals,
  and an empty value means `ok`.
- **`fail_then_succeed:N` counts the global attempt number**, including abandoned attempts and
  attempts from earlier retry budgets ("by attempt number").
- **A recovered event is due immediately** (no backoff), because the crash was the worker's
  fault, not the event's. It still counts as an attempt (see limitations).
- **Every event type is processed the same way**: it records `data.orderId` in
  `processed_orders`. The brief has only `order.created`.
- **Defaults:** 5 attempts per budget; backoff 1 s × 2ⁿ (capped at 30 s) with equal jitter;
  10 s lease with 3 s heartbeat (short, so the crash demo is quick); 4 events per worker.
- **One backend image** runs the API, workers and migrator. Migrations run once in their own
  container before anything else starts.
- **Manual retry** is `POST /events/:eventId/retry` (and a button on the ops page). It is only
  allowed for `failed` events (`409` otherwise).

## What I'd do next (in priority order)

1. **Idempotency for real side effects.** Pass `eventId` as an idempotency key to the
   downstream call, or move the call to a transactional outbox. Today only the database write
   is exactly-once, and that is the largest correctness gap once the action is a real API.
2. **Observability.** Metrics for queue depth, age of the oldest pending event, attempts,
   recoveries and failures, with alerts on `failed`. Without them a stuck system is only
   noticed through the ops page.
3. **Execution timeout and separate pools for slow work**, so a few long events can't starve
   the queue (the slot-blocking limitation above).
4. **`LISTEN/NOTIFY` wake-ups** instead of polling, for lower latency and no idle load.
   Polling would stay as the fallback.
5. **Webhook signature verification (HMAC) and rate limiting.** Required before exposing
   `POST /webhooks` publicly; skipped as out of scope.
6. **Retention and partitioning** for `webhook_events` / `event_attempts`, plus paging and bulk
   retry on the ops page.

## API

| Method & path | Description |
|---|---|
| `POST /webhooks` | Accept an event → `202 {eventId, duplicate}`; `400` on invalid input |
| `GET /events?status=&limit=&offset=` | Events, newest first |
| `GET /events/stats` | Counts per status, `processed_orders` rows, max attempts |
| `GET /events/:eventId` | Event, stored payload, attempt history, `processed_orders` row |
| `POST /events/:eventId/retry` | Manual retry of a `failed` event → `202`; `404` / `409` |
| `GET /health` | Liveness, including the database |

## Tests

39 tests: unit tests for `simulate` parsing and backoff, plus integration tests against real
PostgreSQL covering concurrency, duplicate deliveries, retries, manual retry, crash recovery
and fencing (`backend/test`).

```bash
# In Docker (no local Node needed), against the compose PostgreSQL:
docker compose --profile test run --rm tests

# Or locally (Node 22), with PostgreSQL from compose on port 55432:
docker compose up -d postgres
cd backend && npm ci && npm test
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and builds on every push.

## Repository layout

```
backend/                 NestJS: API, workers and migrator (one image)
  src/webhooks/          POST /webhooks ingestion
  src/events/            ops read API + manual retry
  src/processing/        queue (claim/complete/fail/renew/recover), worker loop, simulate
  src/database/          Kysely setup, schema types, migrations
  test/                  unit + integration tests
  scripts/burst.ts       load generator for the burst demo
frontend/                Next.js operations page
scripts/                 demo scenarios (bash)
docker-compose.yml       postgres, migrate, api, worker-1, worker-2, frontend (+ test/tools profiles)
```
