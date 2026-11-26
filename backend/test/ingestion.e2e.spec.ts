import './support/test-env';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { DB } from '../src/database/database';
import { openTestDb, resetTables } from './support/helpers';

describe('POST /webhooks (real HTTP + PostgreSQL)', () => {
  let app: INestApplication;
  let db: DB;

  beforeAll(async () => {
    db = await openTestDb();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }));
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  beforeEach(() => resetTables(db));

  const post = (body: object) => request(app.getHttpServer()).post('/webhooks').send(body);
  const event = (data: object = { orderId: 'ORD-1001', customerId: 'CUS-42' }) => ({
    eventId: 'evt_123',
    type: 'order.created',
    data,
  });

  it('stores exactly one event when the same eventId arrives 50 times at once', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(event())));

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(202));
    expect(responses.filter((r) => r.body.duplicate === false)).toHaveLength(1);

    const rows = await db.selectFrom('webhook_events').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', delivery_count: 50, attempt_count: 0 });
  });

  it('keeps the first payload when a later delivery reuses the eventId with other data', async () => {
    await post(event({ orderId: 'ORD-FIRST' })).expect(202);
    const later = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post(event({ orderId: `ORD-LATER-${i}` }))),
    );

    expect(later.every((r) => r.status === 202 && r.body.duplicate === true)).toBe(true);
    const row = await db.selectFrom('webhook_events').selectAll().executeTakeFirstOrThrow();
    expect(row.payload).toEqual({
      eventId: 'evt_123',
      type: 'order.created',
      data: { orderId: 'ORD-FIRST' },
    });
    expect(row).toMatchObject({ delivery_count: 11, conflicting_delivery_count: 10 });
  });

  it('rejects malformed events without storing anything', async () => {
    await post({ eventId: '', type: 'order.created', data: {} }).expect(400);
    await post({ eventId: 'evt_x', type: 'order.created', data: 'not-an-object' }).expect(400);
    await post({ type: 'order.created', data: {} }).expect(400);

    const rows = await db.selectFrom('webhook_events').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
