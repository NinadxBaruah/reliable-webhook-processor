import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import type { Env } from '../config/env';
import type { DB } from '../database/database';
import { InjectDb } from '../database/database.module';
import type { EventStatus, WebhookEvent } from '../database/database.types';
import type { ListEventsQuery } from './dto/list-events.query';

export interface EventSummary {
  eventId: string;
  type: string;
  status: EventStatus;
  orderId: unknown;
  simulate: unknown;
  attemptCount: number;
  /** Attempts used in the current retry budget (resets on manual retry, attemptCount does not). */
  attemptsInBudget: number;
  lastError: string | null;
  lockedBy: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date;
  deliveryCount: number;
  conflictingDeliveryCount: number;
  receivedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function toSummary(row: WebhookEvent): EventSummary {
  const data = (row.payload as { data?: Record<string, unknown> })?.data ?? {};
  return {
    eventId: row.event_id,
    type: row.type,
    status: row.status,
    orderId: data.orderId ?? null,
    simulate: data.simulate ?? null,
    attemptCount: row.attempt_count,
    attemptsInBudget: row.attempt_count - row.budget_start_attempt,
    lastError: row.last_error,
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    deliveryCount: row.delivery_count,
    conflictingDeliveryCount: row.conflicting_delivery_count,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

@Injectable()
export class EventsService {
  constructor(
    @InjectDb() private readonly db: DB,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(query: ListEventsQuery): Promise<{ items: EventSummary[]; total: number }> {
    let base = this.db.selectFrom('webhook_events');
    if (query.status) base = base.where('status', '=', query.status);

    const [rows, count] = await Promise.all([
      base
        .selectAll()
        .orderBy('received_at', 'desc')
        .orderBy('event_id')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toSummary), total: Number(count.total) };
  }

  async stats() {
    const [byStatus, processed] = await Promise.all([
      this.db
        .selectFrom('webhook_events')
        .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
        .groupBy('status')
        .execute(),
      this.db
        .selectFrom('processed_orders')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
    ]);

    const counts: Record<EventStatus, number> = {
      pending: 0,
      processing: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const row of byStatus) counts[row.status] = Number(row.count);

    return {
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      processedOrders: Number(processed.count),
      maxAttempts: this.config.get('MAX_ATTEMPTS', { infer: true }),
    };
  }

  async get(eventId: string) {
    const row = await this.db
      .selectFrom('webhook_events')
      .selectAll()
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`Event ${eventId} not found`);

    const [attempts, processedOrder] = await Promise.all([
      this.db
        .selectFrom('event_attempts')
        .select(['attempt_number', 'worker_id', 'started_at', 'finished_at', 'result', 'error'])
        .where('event_id', '=', eventId)
        .orderBy('attempt_number')
        .execute(),
      this.db
        .selectFrom('processed_orders')
        .selectAll()
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    ]);

    return {
      ...toSummary(row),
      payload: row.payload,
      attempts: attempts.map((a) => ({
        attemptNumber: a.attempt_number,
        workerId: a.worker_id,
        startedAt: a.started_at,
        finishedAt: a.finished_at,
        result: a.result,
        error: a.error,
      })),
      processedOrder: processedOrder
        ? { orderId: processedOrder.order_id, processedAt: processedOrder.processed_at }
        : null,
    };
  }

  /**
   * Manual retry of a permanently failed event: it gets a fresh retry budget and is due at once.
   * attempt_count is left alone, so attempt numbers keep increasing across budgets.
   * The status check is part of the UPDATE, so two simultaneous retries cannot both apply.
   */
  async retry(eventId: string): Promise<EventSummary> {
    const row = await this.db
      .updateTable('webhook_events')
      .set({
        status: 'pending',
        budget_start_attempt: sql`attempt_count`,
        next_attempt_at: sql`now()`,
        completed_at: null,
        updated_at: sql`now()`,
      })
      .where('event_id', '=', eventId)
      .where('status', '=', 'failed')
      .returningAll()
      .executeTakeFirst();
    if (row) return toSummary(row);

    const exists = await this.db
      .selectFrom('webhook_events')
      .select('status')
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (!exists) throw new NotFoundException(`Event ${eventId} not found`);
    throw new ConflictException(
      `Only failed events can be retried; event ${eventId} is ${exists.status}`,
    );
  }
}
