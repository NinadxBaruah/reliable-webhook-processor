import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

export type EventStatus = 'pending' | 'processing' | 'succeeded' | 'failed';
export type AttemptResult = 'running' | 'succeeded' | 'failed' | 'abandoned';

export interface WebhookEventsTable {
  event_id: string;
  type: string;
  /** The first delivered body, exactly as received. Later deliveries never overwrite it. */
  payload: ColumnType<unknown, string, never>;
  status: Generated<EventStatus>;
  /** Total attempts ever started. Doubles as the number of the latest attempt. */
  attempt_count: Generated<number>;
  /** attempt_count at the moment the current retry budget began (0, or reset by manual retry). */
  budget_start_attempt: Generated<number>;
  next_attempt_at: Generated<Date>;
  locked_by: string | null;
  lease_token: string | null;
  lease_expires_at: NullableTimestamp;
  last_error: string | null;
  delivery_count: Generated<number>;
  conflicting_delivery_count: Generated<number>;
  received_at: Generated<Date>;
  last_delivery_at: Generated<Date>;
  updated_at: Generated<Date>;
  completed_at: NullableTimestamp;
}

export interface ProcessedOrdersTable {
  event_id: string;
  order_id: string;
  processed_at: Generated<Date>;
}

export interface EventAttemptsTable {
  id: Generated<string>;
  event_id: string;
  attempt_number: number;
  worker_id: string;
  started_at: Generated<Date>;
  finished_at: NullableTimestamp;
  result: Generated<AttemptResult>;
  error: string | null;
}

export interface Database {
  webhook_events: WebhookEventsTable;
  processed_orders: ProcessedOrdersTable;
  event_attempts: EventAttemptsTable;
}

export type WebhookEvent = Selectable<WebhookEventsTable>;
export type NewWebhookEvent = Insertable<WebhookEventsTable>;
export type EventAttempt = Selectable<EventAttemptsTable>;
export type ProcessedOrder = Selectable<ProcessedOrdersTable>;
