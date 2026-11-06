import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { acceptWebhook, initializeReceiver } from '../../../docs/examples/webhook-receiver.mjs';

// An isolated schema shared by real concurrent clients: durable uniqueness and
// transaction rollback are checked by PostgreSQL, not emulated in JavaScript.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('receiver durable PostgreSQL deduplication', () => {
  let admin, pool;
  const schema = 'receiver_' + randomUUID().replaceAll('-', '');
  const makeEvent = () => ({ id: randomUUID(), occurredAt: new Date().toISOString(), data: { accountId: randomUUID(), messageId: randomUUID() } });
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await initializeReceiver(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('accepts simultaneous duplicates once and still deduplicates after reconnect', async () => {
    const event = makeEvent();
    const results = await Promise.all(Array.from({ length: 4 }, () => acceptWebhook(pool, event)));
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    expect((await pool.query('SELECT * FROM webhook_receiver_jobs WHERE event_id=$1', [event.id])).rowCount).toBe(1);
    const restartedPool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    try { expect(await acceptWebhook(restartedPool, event)).toEqual({ duplicate: true }); }
    finally { await restartedPool.end(); }
  });

  it('rolls back deduplication when inserting the work item fails, then can retry', async () => {
    const event = makeEvent();
    // A database constraint represents the consumer's transactional business failure.
    await pool.query(`ALTER TABLE webhook_receiver_jobs ADD CONSTRAINT reject_fixture CHECK (event_id <> '${event.id}'::uuid)`);
    await expect(acceptWebhook(pool, event)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM webhook_receiver_inbox WHERE event_id=$1', [event.id])).rowCount).toBe(0);
    await pool.query('ALTER TABLE webhook_receiver_jobs DROP CONSTRAINT reject_fixture');
    expect(await acceptWebhook(pool, event)).toEqual({ duplicate: false });
  });
});
