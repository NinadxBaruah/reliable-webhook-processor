import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env';
import type { DB } from '../src/database/database';
import { EventsService } from '../src/events/events.service';
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

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 40;

describe('retries', () => {
  let db: DB;
  let worker: TestWorker;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(() => db.destroy());
  beforeEach(async () => {
    await resetTables(db);
    worker = buildWorker(db, {
      maxAttempts: MAX_ATTEMPTS,
      backoffBaseMs: BACKOFF_BASE_MS,
      backoffMaxMs: 1000,
    });
    worker.runner.start();
  });
  afterEach(() => worker.runner.stop());

  it('retries a temporary failure with backoff until it succeeds', async () => {
    await insertEvent(db, 'evt_temp', { orderId: 'ORD-1', simulate: 'fail_then_succeed:2' });
    await waitUntilTerminal(db, ['evt_temp']);

    expect(await eventRow(db, 'evt_temp')).toMatchObject({ status: 'succeeded', attempt_count: 3 });
    const attempts = await attemptsOf(db, 'evt_temp');
    expect(attempts.map((a) => a.result)).toEqual(['failed', 'failed', 'succeeded']);
    expect(await processedCount(db, 'evt_temp')).toBe(1);

    // Backoff: each retry waited at least the jitter floor (half of base * 2^(n-1)).
    for (let n = 1; n < attempts.length; n++) {
      const waited = attempts[n].started_at.getTime() - attempts[n - 1].finished_at!.getTime();
      expect(waited).toBeGreaterThanOrEqual((BACKOFF_BASE_MS * 2 ** (n - 1)) / 2 - 1);
    }
  });

  it('stops after MAX_ATTEMPTS and marks the event permanently failed', async () => {
    await insertEvent(db, 'evt_bad', { orderId: 'ORD-2', simulate: 'always_fail' });
    await waitUntilTerminal(db, ['evt_bad']);

    // Give the worker time to (wrongly) try again before checking that it did not.
    await new Promise((r) => setTimeout(r, 400));

    const event = await eventRow(db, 'evt_bad');
    expect(event).toMatchObject({ status: 'failed', attempt_count: MAX_ATTEMPTS });
    expect(event.last_error).toMatch(/always_fail/);
    expect((await attemptsOf(db, 'evt_bad')).map((a) => a.result)).toEqual(
      Array(MAX_ATTEMPTS).fill('failed'),
    );
    expect(await processedCount(db, 'evt_bad')).toBe(0);
  });

  it('does not retry errors that can never succeed', async () => {
    await insertEvent(db, 'evt_weird', { orderId: 'ORD-3', simulate: 'explode' });
    await insertEvent(db, 'evt_no_order', { simulate: 'ok' });
    await waitUntilTerminal(db, ['evt_weird', 'evt_no_order']);

    expect(await eventRow(db, 'evt_weird')).toMatchObject({ status: 'failed', attempt_count: 1 });
    expect(await eventRow(db, 'evt_no_order')).toMatchObject({
      status: 'failed',
      attempt_count: 1,
    });
  });

  it('manual retry gives a fresh budget and attempt numbers keep increasing', async () => {
    const config = { get: () => MAX_ATTEMPTS } as unknown as ConfigService<Env, true>;
    const events = new EventsService(db, config);

    // Needs 5 failures, more than one budget of 3 attempts.
    await insertEvent(db, 'evt_manual', { orderId: 'ORD-4', simulate: 'fail_then_succeed:5' });
    await waitUntilTerminal(db, ['evt_manual']);
    expect(await eventRow(db, 'evt_manual')).toMatchObject({ status: 'failed', attempt_count: 3 });

    // Only failed events can be retried.
    await insertEvent(db, 'evt_fresh');
    await expect(events.retry('evt_fresh')).rejects.toBeInstanceOf(ConflictException);

    const retried = await events.retry('evt_manual');
    expect(retried).toMatchObject({ status: 'pending', attemptCount: 3, attemptsInBudget: 0 });
    await waitUntilTerminal(db, ['evt_manual']);

    const event = await eventRow(db, 'evt_manual');
    expect(event).toMatchObject({ status: 'succeeded', attempt_count: 6, budget_start_attempt: 3 });
    expect((await attemptsOf(db, 'evt_manual')).map((a) => [a.attempt_number, a.result])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'failed'],
      [4, 'failed'],
      [5, 'failed'],
      [6, 'succeeded'],
    ]);
    expect(await processedCount(db, 'evt_manual')).toBe(1);
  });
});
