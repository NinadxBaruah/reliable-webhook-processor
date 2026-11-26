import type { DB } from '../src/database/database';
import { LeaseLostError } from '../src/processing/errors';
import {
  attemptsOf,
  buildWorker,
  eventRow,
  insertEvent,
  openTestDb,
  processedCount,
  resetTables,
  type TestWorker,
  waitUntilTerminal,
} from './support/helpers';

const LEASE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A "crashed" worker is simulated by claiming an event through the queue and then doing nothing:
 * no heartbeat, no completion, exactly what is left behind by a process killed with SIGKILL.
 */
describe('crash recovery', () => {
  let db: DB;
  let started: TestWorker[] = [];

  const worker = (workerId: string, overrides = {}) =>
    buildWorker(db, { workerId, leaseMs: LEASE_MS, heartbeatMs: 100, ...overrides });
  const startWorker = (workerId: string, overrides = {}) => {
    const w = worker(workerId, overrides);
    w.runner.start();
    started.push(w);
    return w;
  };

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetTables(db));
  afterEach(async () => {
    await Promise.all(started.map((w) => w.runner.stop()));
    started = [];
  });

  it('another worker picks up an event whose worker died after claiming it', async () => {
    await insertEvent(db, 'evt_1');
    const [claim] = await worker('crashed').queue.claim(1);
    expect(claim.eventId).toBe('evt_1');

    startWorker('rescuer');
    await waitUntilTerminal(db, ['evt_1']);

    expect(await eventRow(db, 'evt_1')).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    const attempts = await attemptsOf(db, 'evt_1');
    expect(attempts.map((a) => [a.worker_id, a.result])).toEqual([
      ['crashed', 'abandoned'],
      ['rescuer', 'succeeded'],
    ]);
    expect(attempts[0].error).toMatch(/Lease expired/);
    expect(await processedCount(db, 'evt_1')).toBe(1);
  });

  it('never writes a second processed_orders row, even if the crash came after the business row', async () => {
    await insertEvent(db, 'evt_2');
    await worker('crashed').queue.claim(1);
    // Worst case: the business row was committed, then the process died before marking the
    // event complete (this cannot happen through the normal path, which does both in one
    // transaction, so it is forced here to prove the database guard as well).
    await db.insertInto('processed_orders').values({ event_id: 'evt_2', order_id: 'X' }).execute();

    startWorker('rescuer');
    await waitUntilTerminal(db, ['evt_2']);

    expect(await eventRow(db, 'evt_2')).toMatchObject({ status: 'succeeded' });
    expect(await processedCount(db, 'evt_2')).toBe(1);
  });

  it('a crash in the middle of the completion transaction leaves no trace of the business row', async () => {
    await insertEvent(db, 'evt_3');
    const crashed = worker('crashed');
    const [claim] = await crashed.queue.claim(1);

    await expect(
      crashed.queue.completeWith(claim, async (trx) => {
        await trx
          .insertInto('processed_orders')
          .values({ event_id: 'evt_3', order_id: 'ORD-evt_3' })
          .execute();
        throw new Error('process died before commit');
      }),
    ).rejects.toThrow('process died before commit');
    expect(await processedCount(db, 'evt_3')).toBe(0);
    expect(await eventRow(db, 'evt_3')).toMatchObject({ status: 'processing' });

    startWorker('rescuer');
    await waitUntilTerminal(db, ['evt_3']);
    expect(await eventRow(db, 'evt_3')).toMatchObject({ status: 'succeeded' });
    expect(await processedCount(db, 'evt_3')).toBe(1);
  });

  it('fences off a worker that comes back after its lease was taken over', async () => {
    await insertEvent(db, 'evt_4');
    const zombie = worker('zombie');
    const [claim] = await zombie.queue.claim(1);
    await sleep(LEASE_MS + 100); // the zombie is frozen (GC pause, network partition, ...)

    startWorker('rescuer');
    await waitUntilTerminal(db, ['evt_4']);

    // The zombie wakes up and tries to finish its old attempt: every write is refused.
    expect(await zombie.queue.renewLease(claim)).toBe(false);
    await expect(
      zombie.queue.completeWith(claim, async (trx) => {
        await trx
          .insertInto('processed_orders')
          .values({ event_id: 'evt_4', order_id: 'ZOMBIE' })
          .onConflict((oc) => oc.column('event_id').doNothing())
          .execute();
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await zombie.queue.fail(claim, 'late', { retryable: true, delayMs: 0 })).toBeNull();

    expect(await eventRow(db, 'evt_4')).toMatchObject({ status: 'succeeded', last_error: null });
    const order = await db.selectFrom('processed_orders').selectAll().execute();
    expect(order).toEqual([expect.objectContaining({ event_id: 'evt_4', order_id: 'ORD-evt_4' })]);
  });

  it('does not take over work that runs longer than the lease while its worker is alive', async () => {
    await insertEvent(db, 'evt_slow', { orderId: 'ORD-slow', simulate: 'slow:1.2' }); // 4x the lease
    startWorker('owner');
    await sleep(50);
    startWorker('other');

    await waitUntilTerminal(db, ['evt_slow']);
    const attempts = await attemptsOf(db, 'evt_slow');
    expect(attempts.map((a) => [a.worker_id, a.result])).toEqual([['owner', 'succeeded']]);
    expect(await processedCount(db, 'evt_slow')).toBe(1);
  });

  it('a crash on the last allowed attempt marks the event failed instead of looping', async () => {
    await insertEvent(db, 'evt_5');
    await worker('crashed', { maxAttempts: 1 }).queue.claim(1);

    startWorker('rescuer', { maxAttempts: 1 });
    await waitUntilTerminal(db, ['evt_5']);

    expect(await eventRow(db, 'evt_5')).toMatchObject({ status: 'failed', attempt_count: 1 });
    expect((await attemptsOf(db, 'evt_5')).map((a) => a.result)).toEqual(['abandoned']);
    expect(await processedCount(db, 'evt_5')).toBe(0);
  });
});
