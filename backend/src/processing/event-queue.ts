import { Inject, Injectable } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import type { DB } from '../database/database';
import { InjectDb } from '../database/database.module';
import type { Database, EventStatus } from '../database/database.types';
import { LeaseLostError } from './errors';
import { WORKER_SETTINGS, type WorkerSettings } from './worker-settings';

export interface StoredPayload {
  eventId: string;
  type: string;
  data: Record<string, unknown>;
}

/** An event this worker owns until its lease expires. Every write is fenced by `leaseToken`. */
export interface ClaimedEvent {
  eventId: string;
  type: string;
  payload: StoredPayload;
  /** 1-based and never reset, also across manual retries. */
  attemptNumber: number;
  /** attemptNumber - budgetStartAttempt = attempts used in the current retry budget. */
  budgetStartAttempt: number;
  leaseToken: string;
}

interface ClaimRow {
  event_id: string;
  type: string;
  payload: StoredPayload;
  attempt_count: number;
  budget_start_attempt: number;
  lease_token: string;
}

/**
 * The PostgreSQL-backed queue. All state lives in webhook_events; every transition is a single
 * statement or transaction guarded by row locks, so any number of worker processes can share it.
 * All timestamps come from the database clock, so worker clock drift does not matter.
 */
@Injectable()
export class EventQueue {
  constructor(
    @InjectDb() private readonly db: DB,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  /**
   * Claims up to `limit` due events and opens an attempt for each, in one statement.
   * FOR UPDATE SKIP LOCKED makes concurrent claimers pick disjoint rows without waiting on each
   * other, and only 'pending' rows are eligible, so an event has at most one owner at a time.
   */
  async claim(limit: number): Promise<ClaimedEvent[]> {
    const { workerId, leaseMs } = this.settings;
    const { rows } = await sql<ClaimRow>`
      with next as (
        select event_id
        from webhook_events
        where status = 'pending' and next_attempt_at <= now()
        order by next_attempt_at, event_id
        limit ${limit}::int
        for update skip locked
      ),
      claimed as (
        update webhook_events e
        set status = 'processing',
            attempt_count = e.attempt_count + 1,
            locked_by = ${workerId},
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + ${leaseMs}::int * interval '1 millisecond',
            updated_at = now()
        from next
        where e.event_id = next.event_id
        returning e.event_id, e.type, e.payload, e.attempt_count, e.budget_start_attempt, e.lease_token
      ),
      attempts as (
        insert into event_attempts (event_id, attempt_number, worker_id)
        select event_id, attempt_count, ${workerId} from claimed
      )
      select * from claimed
    `.execute(this.db);

    return rows.map((r) => ({
      eventId: r.event_id,
      type: r.type,
      payload: r.payload,
      attemptNumber: r.attempt_count,
      budgetStartAttempt: r.budget_start_attempt,
      leaseToken: r.lease_token,
    }));
  }

  /**
   * Heartbeat: pushes the lease forward while the worker is still working on the event.
   * Returns false when the lease is no longer ours (expired and recovered by another worker).
   */
  async renewLease(claim: ClaimedEvent): Promise<boolean> {
    const result = await this.db
      .updateTable('webhook_events')
      .set({
        lease_expires_at: sql`now() + ${this.settings.leaseMs}::int * interval '1 millisecond'`,
      })
      .where('event_id', '=', claim.eventId)
      .where('status', '=', 'processing')
      .where('lease_token', '=', claim.leaseToken)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Crash recovery. A 'processing' event whose lease expired belongs to a worker that stopped
   * renewing it (killed, crashed, frozen or cut off from the database). Its open attempt is closed
   * as 'abandoned' and the event goes back to 'pending' for immediate pickup, or to 'failed' if
   * that attempt used up the retry budget. SKIP LOCKED lets every worker run this concurrently.
   * Nothing here touches processed_orders: if the dead worker had committed its business row it
   * would also have committed 'succeeded', and the event would not be in 'processing'.
   */
  async recoverExpiredLeases(limit = 100): Promise<{ eventId: string; status: EventStatus }[]> {
    const { rows } = await sql<{ event_id: string; status: EventStatus }>`
      with expired as (
        select event_id, attempt_count, budget_start_attempt, locked_by
        from webhook_events
        where status = 'processing' and lease_expires_at < now()
        order by lease_expires_at
        limit ${limit}::int
        for update skip locked
      ),
      attempt as (
        update event_attempts a
        set result = 'abandoned',
            finished_at = now(),
            error = 'Lease expired: worker ' || expired.locked_by || ' stopped renewing it'
        from expired
        where a.event_id = expired.event_id
          and a.attempt_number = expired.attempt_count
          and a.result = 'running'
      )
      update webhook_events e
      set status = case
            when expired.attempt_count - expired.budget_start_attempt >= ${this.settings.maxAttempts}::int
              then 'failed' else 'pending' end,
          next_attempt_at = now(),
          last_error = 'Lease expired: worker ' || expired.locked_by || ' stopped renewing it',
          locked_by = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = now(),
          completed_at = case
            when expired.attempt_count - expired.budget_start_attempt >= ${this.settings.maxAttempts}::int
              then now() end
      from expired
      where e.event_id = expired.event_id
      returning e.event_id, e.status
    `.execute(this.db);
    return rows.map((r) => ({ eventId: r.event_id, status: r.status }));
  }

  /**
   * Runs the business action and marks the event succeeded in ONE transaction, after re-checking
   * (and row-locking) the lease. Either both the business row and 'succeeded' are committed or
   * neither is, so a crash can never leave work done but the event unfinished. A worker that lost
   * its lease gets LeaseLostError and writes nothing.
   */
  async completeWith(
    claim: ClaimedEvent,
    businessAction: (trx: Transaction<Database>) => Promise<void>,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const owned = await trx
        .selectFrom('webhook_events')
        .select('event_id')
        .where('event_id', '=', claim.eventId)
        .where('status', '=', 'processing')
        .where('lease_token', '=', claim.leaseToken)
        .forUpdate()
        .executeTakeFirst();
      if (!owned) {
        throw new LeaseLostError(`Lease on ${claim.eventId} was lost before completion`);
      }

      await businessAction(trx);

      await trx
        .updateTable('webhook_events')
        .set({
          status: 'succeeded',
          completed_at: sql`now()`,
          updated_at: sql`now()`,
          last_error: null,
          locked_by: null,
          lease_token: null,
          lease_expires_at: null,
        })
        .where('event_id', '=', claim.eventId)
        .execute();

      await trx
        .updateTable('event_attempts')
        .set({ result: 'succeeded', finished_at: sql`now()` })
        .where('event_id', '=', claim.eventId)
        .where('attempt_number', '=', claim.attemptNumber)
        .execute();
    });
  }

  /**
   * Records a failed attempt. The event goes back to 'pending' with a backoff delay, or to
   * 'failed' when the error is not retryable or the retry budget is used up.
   * Returns the new status, or null if this worker no longer held the lease (nothing written).
   */
  async fail(
    claim: ClaimedEvent,
    error: string,
    opts: { retryable: boolean; delayMs: number },
  ): Promise<EventStatus | null> {
    const attemptsUsed = claim.attemptNumber - claim.budgetStartAttempt;
    const nextStatus: EventStatus =
      opts.retryable && attemptsUsed < this.settings.maxAttempts ? 'pending' : 'failed';

    const { rows } = await sql<{ event_id: string }>`
      with updated as (
        update webhook_events
        set status = ${nextStatus},
            next_attempt_at = now() + ${opts.delayMs}::int * interval '1 millisecond',
            last_error = ${error},
            locked_by = null,
            lease_token = null,
            lease_expires_at = null,
            updated_at = now(),
            completed_at = case when ${nextStatus}::text = 'failed' then now() end
        where event_id = ${claim.eventId}
          and status = 'processing'
          and lease_token = ${claim.leaseToken}::uuid
        returning event_id, attempt_count
      ),
      attempt as (
        update event_attempts a
        set result = 'failed', finished_at = now(), error = ${error}
        from updated
        where a.event_id = updated.event_id and a.attempt_number = updated.attempt_count
      )
      select event_id from updated
    `.execute(this.db);

    return rows.length ? nextStatus : null;
  }
}
