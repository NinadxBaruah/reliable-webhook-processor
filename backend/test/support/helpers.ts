import { sql } from 'kysely';
import { Client } from 'pg';
import { createDatabase, type DB, migrateToLatest } from '../../src/database/database';
import { EventProcessor } from '../../src/processing/event-processor';
import { EventQueue } from '../../src/processing/event-queue';
import { WorkerRunner } from '../../src/processing/worker-runner';
import type { WorkerSettings } from '../../src/processing/worker-settings';

/**
 * Tests run against a real PostgreSQL: the guarantees under test (row locks, SKIP LOCKED,
 * unique constraints, transactions) only exist there. Start it with `docker compose up -d postgres`.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/webhooks_test';

/**
 * Creates the test database if needed and migrates it. Runs from Jest's globalSetup. All test
 * files share this database and truncate it between tests, so Jest runs them one at a time
 * (--runInBand); the concurrency under test is inside each test, between workers.
 */
export async function prepareTestDatabase(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await admin.query(`create database "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  const db = createDatabase(TEST_DATABASE_URL, 1);
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}

export function openTestDb(poolMax = 20): Promise<DB> {
  return Promise.resolve(createDatabase(TEST_DATABASE_URL, poolMax));
}

export async function resetTables(db: DB): Promise<void> {
  await sql`truncate webhook_events, processed_orders, event_attempts`.execute(db);
}

export const fastSettings = (overrides: Partial<WorkerSettings> = {}): WorkerSettings => ({
  workerId: 'test-worker',
  concurrency: 4,
  pollIntervalMs: 20,
  maxAttempts: 3,
  backoffBaseMs: 20,
  backoffMaxMs: 100,
  leaseMs: 1000,
  heartbeatMs: 200,
  recoveryIntervalMs: 50,
  shutdownGraceMs: 2000,
  ...overrides,
});

export interface TestWorker {
  queue: EventQueue;
  runner: WorkerRunner;
  settings: WorkerSettings;
}

/** A complete worker (queue + processor + loop), as one worker container would run it. */
export function buildWorker(db: DB, overrides: Partial<WorkerSettings> = {}): TestWorker {
  const settings = fastSettings(overrides);
  const queue = new EventQueue(db, settings);
  const runner = new WorkerRunner(queue, new EventProcessor(queue), settings);
  return { queue, runner, settings };
}

export async function insertEvent(
  db: DB,
  eventId: string,
  data: Record<string, unknown> = { orderId: `ORD-${eventId}` },
): Promise<void> {
  await db
    .insertInto('webhook_events')
    .values({
      event_id: eventId,
      type: 'order.created',
      payload: JSON.stringify({ eventId, type: 'order.created', data }),
    })
    .execute();
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 25, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function eventRow(db: DB, eventId: string) {
  return db
    .selectFrom('webhook_events')
    .selectAll()
    .where('event_id', '=', eventId)
    .executeTakeFirstOrThrow();
}

export async function attemptsOf(db: DB, eventId: string) {
  return db
    .selectFrom('event_attempts')
    .selectAll()
    .where('event_id', '=', eventId)
    .orderBy('attempt_number')
    .execute();
}

export async function processedCount(db: DB, eventId?: string): Promise<number> {
  let q = db.selectFrom('processed_orders').select((eb) => eb.fn.countAll<string>().as('n'));
  if (eventId) q = q.where('event_id', '=', eventId);
  return Number((await q.executeTakeFirstOrThrow()).n);
}

export async function waitUntilTerminal(db: DB, eventIds: string[], timeoutMs = 20_000) {
  await waitFor(
    async () => {
      const open = await db
        .selectFrom('webhook_events')
        .select('event_id')
        .where('event_id', 'in', eventIds)
        .where('status', 'in', ['pending', 'processing'])
        .limit(1)
        .execute();
      return open.length === 0;
    },
    { timeoutMs, what: `${eventIds.length} event(s) to reach a terminal state` },
  );
}
