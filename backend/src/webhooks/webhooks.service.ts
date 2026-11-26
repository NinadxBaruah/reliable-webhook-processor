import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { DB } from '../database/database';
import { InjectDb } from '../database/database.module';
import type { IngestResult, WebhookEventDto } from './dto/webhook-event.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(@InjectDb() private readonly db: DB) {}

  /**
   * Persists a delivery in one atomic statement. The primary key on event_id decides the winner
   * when the same event arrives several times at once; every later delivery only bumps counters
   * and never touches the stored payload or the processing state.
   */
  async ingest(event: WebhookEventDto): Promise<IngestResult> {
    const payload = JSON.stringify({ eventId: event.eventId, type: event.type, data: event.data });

    const row = await this.db
      .insertInto('webhook_events')
      .values({ event_id: event.eventId, type: event.type, payload })
      .onConflict((oc) =>
        oc.column('event_id').doUpdateSet({
          delivery_count: sql`webhook_events.delivery_count + 1`,
          conflicting_delivery_count: sql`webhook_events.conflicting_delivery_count
            + (webhook_events.payload <> excluded.payload)::int`,
          last_delivery_at: sql`now()`,
        }),
      )
      // xmax is 0 only for a freshly inserted tuple, so this tells a new event from a redelivery.
      .returning([
        sql<boolean>`(xmax = 0)`.as('inserted'),
        sql<boolean>`(payload = ${payload}::jsonb)`.as('same_payload'),
      ])
      .executeTakeFirstOrThrow();

    if (!row.inserted) {
      if (row.same_payload) {
        this.logger.log({ eventId: event.eventId }, 'Duplicate delivery ignored');
      } else {
        this.logger.warn(
          { eventId: event.eventId },
          'Duplicate eventId with a different payload; keeping the first payload',
        );
      }
    }

    return { eventId: event.eventId, duplicate: !row.inserted };
  }
}
