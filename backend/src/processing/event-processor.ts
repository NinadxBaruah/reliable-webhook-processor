import { Injectable } from '@nestjs/common';
import { NonRetryableError } from './errors';
import { type ClaimedEvent, EventQueue } from './event-queue';
import { parseSimulation, runSimulation } from './simulation';

/**
 * What "processing an event" means: call the (simulated) downstream service, then record the
 * order in processed_orders. The record is written in the same transaction that marks the event
 * succeeded, and processed_orders.event_id is the primary key, so an event can be recorded at most
 * once even if it is processed again after a crash or by a worker that lost its lease.
 */
@Injectable()
export class EventProcessor {
  constructor(private readonly queue: EventQueue) {}

  async process(claim: ClaimedEvent, signal: AbortSignal): Promise<void> {
    const data = claim.payload.data ?? {};
    const orderId = normalizeOrderId(data.orderId);
    const simulation = parseSimulation(data.simulate);

    await runSimulation(simulation, claim.attemptNumber, signal);

    await this.queue.completeWith(claim, async (trx) => {
      await trx
        .insertInto('processed_orders')
        .values({ event_id: claim.eventId, order_id: orderId })
        .onConflict((oc) => oc.column('event_id').doNothing())
        .execute();
    });
  }
}

function normalizeOrderId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new NonRetryableError('data.orderId must be a non-empty string');
}
