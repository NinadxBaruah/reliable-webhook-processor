import { type Kysely, sql } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any -- migrations must not depend on the live schema types */

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('webhook_events')
    .addColumn('event_id', 'text', (c) => c.primaryKey())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('attempt_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('budget_start_attempt', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('locked_by', 'text')
    .addColumn('lease_token', 'uuid')
    .addColumn('lease_expires_at', 'timestamptz')
    .addColumn('last_error', 'text')
    .addColumn('delivery_count', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('conflicting_delivery_count', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('received_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_delivery_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .addCheckConstraint(
      'webhook_events_status_check',
      sql`status in ('pending', 'processing', 'succeeded', 'failed')`,
    )
    // A row in 'processing' must always carry a lease, or it could never be recovered.
    .addCheckConstraint(
      'webhook_events_processing_has_lease',
      sql`status <> 'processing' or (lease_token is not null and lease_expires_at is not null and locked_by is not null)`,
    )
    .addCheckConstraint(
      'webhook_events_budget_check',
      sql`budget_start_attempt >= 0 and budget_start_attempt <= attempt_count`,
    )
    .execute();

  // Claim query: oldest due pending event first.
  await sql`create index webhook_events_due_idx on webhook_events (next_attempt_at) where status = 'pending'`.execute(
    db,
  );
  // Recovery query: processing events whose lease ran out.
  await sql`create index webhook_events_lease_idx on webhook_events (lease_expires_at) where status = 'processing'`.execute(
    db,
  );
  await db.schema
    .createIndex('webhook_events_received_idx')
    .on('webhook_events')
    .column('received_at desc')
    .execute();

  // The record of real work. The primary key on event_id is what makes the business action
  // happen at most once per event, no matter how many workers, retries or recoveries run.
  await db.schema
    .createTable('processed_orders')
    .addColumn('event_id', 'text', (c) =>
      c.primaryKey().references('webhook_events.event_id').onDelete('restrict'),
    )
    .addColumn('order_id', 'text', (c) => c.notNull())
    .addColumn('processed_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('event_attempts')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('event_id', 'text', (c) =>
      c.notNull().references('webhook_events.event_id').onDelete('cascade'),
    )
    .addColumn('attempt_number', 'integer', (c) => c.notNull())
    .addColumn('worker_id', 'text', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('finished_at', 'timestamptz')
    .addColumn('result', 'text', (c) => c.notNull().defaultTo('running'))
    .addColumn('error', 'text')
    .addUniqueConstraint('event_attempts_event_attempt_unique', ['event_id', 'attempt_number'])
    .addCheckConstraint(
      'event_attempts_result_check',
      sql`result in ('running', 'succeeded', 'failed', 'abandoned')`,
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('event_attempts').execute();
  await db.schema.dropTable('processed_orders').execute();
  await db.schema.dropTable('webhook_events').execute();
}
