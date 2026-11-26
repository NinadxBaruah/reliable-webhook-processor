import type { DB } from '../src/database/database';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import {
  buildWorker,
  insertEvent,
  openTestDb,
  resetTables,
  type TestWorker,
  waitUntilTerminal,
} from './support/helpers';

describe('several workers sharing the queue', () => {
  let db: DB;
  let workers: TestWorker[] = [];

  beforeAll(async () => {
    db = await openTestDb(40);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetTables(db));
  afterEach(async () => {
    await Promise.all(workers.map((w) => w.runner.stop()));
    workers = [];
  });

  it('gives a single event to exactly one of many simultaneous claimers', async () => {
    await insertEvent(db, 'evt_race');
    const claimers = Array.from({ length: 10 }, (_, i) => buildWorker(db, { workerId: `w${i}` }));

    const results = await Promise.all(claimers.map((w) => w.queue.claim(1)));

    expect(results.flat()).toHaveLength(1);
    const attempts = await db.selectFrom('event_attempts').selectAll().execute();
    expect(attempts).toHaveLength(1);
  });

  it('processes every event exactly once with 4 workers, duplicate deliveries and retries', async () => {
    const ingest = new WebhooksService(db);
    workers = Array.from({ length: 4 }, (_, i) =>
      buildWorker(db, { workerId: `worker-${i + 1}`, concurrency: 5 }),
    );
    workers.forEach((w) => w.runner.start());

    // 150 events, each delivered 3 times concurrently while the workers are already running.
    // Every 4th event fails once first; every 10th is slow, to keep several events in flight.
    const eventIds = Array.from({ length: 150 }, (_, i) => `evt_${i}`);
    const simulate = (i: number) =>
      i % 4 === 0 ? 'fail_then_succeed:1' : i % 10 === 1 ? 'slow:0.05' : 'ok';
    await Promise.all(
      eventIds.flatMap((eventId, i) =>
        Array.from({ length: 3 }, () =>
          ingest.ingest({
            eventId,
            type: 'order.created',
            data: { orderId: `ORD-${i}`, simulate: simulate(i) },
          }),
        ),
      ),
    );

    await waitUntilTerminal(db, eventIds, 30_000);

    const events = await db.selectFrom('webhook_events').selectAll().execute();
    expect(events).toHaveLength(150);
    expect(events.every((e) => e.status === 'succeeded')).toBe(true);

    // The business table: one row per event, never two.
    const perEvent = await db
      .selectFrom('processed_orders')
      .select(['event_id', (eb) => eb.fn.countAll<string>().as('n')])
      .groupBy('event_id')
      .execute();
    expect(perEvent).toHaveLength(150);
    expect(perEvent.filter((r) => Number(r.n) !== 1)).toEqual([]);

    // No event was ever worked on by two workers at once: its attempts never overlap in time,
    // attempt numbers are 1..n without gaps, and n matches the event's attempt count.
    const attempts = await db
      .selectFrom('event_attempts')
      .selectAll()
      .orderBy('event_id')
      .orderBy('attempt_number')
      .execute();
    for (const event of events) {
      const own = attempts.filter((a) => a.event_id === event.event_id);
      expect(own.map((a) => a.attempt_number)).toEqual(
        Array.from({ length: event.attempt_count }, (_, i) => i + 1),
      );
      for (let i = 1; i < own.length; i++) {
        expect(own[i].started_at.getTime()).toBeGreaterThanOrEqual(
          own[i - 1].finished_at!.getTime(),
        );
      }
    }

    // The work really was shared.
    expect(new Set(attempts.map((a) => a.worker_id)).size).toBeGreaterThan(1);
  });
});
