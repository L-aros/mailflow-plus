// Run from this checkout with backend dependencies installed:
// MAILFLOW_WEBHOOK_SECRET='<one-time secret>' DATABASE_URL='postgres://...'
// node docs/examples/webhook-receiver.mjs
// Put a public HTTPS reverse proxy in front of this loopback demo listener.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 64 * 1024;

// Verify the raw bytes before JSON.parse. Do not reserialize JSON for HMAC.
export function verifyWebhook({ secret, timestamp, signature, body, now = Date.now() }) {
  if (typeof secret !== 'string' || !secret || typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp)
      || typeof signature !== 'string' || !/^v1=[0-9a-f]{64}$/.test(signature) || !Buffer.isBuffer(body)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}

export function parseWebhook(body, eventId) {
  const event = JSON.parse(body.toString('utf8'));
  if (!event || typeof eventId !== 'string' || !UUID.test(eventId) || event.id !== eventId
      || event.type !== 'message.received' || !Number.isFinite(Date.parse(event.occurredAt))
      || !UUID.test(event.data?.accountId) || !UUID.test(event.data?.messageId)
      || event.data?.url !== `/api/v1/messages/${event.data.messageId}`) throw new Error('invalid_event');
  return event;
}

export async function initializeReceiver(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_receiver_inbox (
      event_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      message_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      accepted_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS webhook_receiver_jobs (
      event_id uuid PRIMARY KEY REFERENCES webhook_receiver_inbox(event_id),
      processed_at timestamptz
    )
  `);
}

// Both durable deduplication and the work item commit before 204. A crash before
// COMMIT is retryable; a crash after COMMIT is harmless when delivery is repeated.
// A separate consumer can read jobs and use its own read-scoped API token to fetch
// the relative resource URL from a fixed, trusted MailFlow base URL.
export async function acceptWebhook(pool, event) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`
      INSERT INTO webhook_receiver_inbox(event_id, account_id, message_id, occurred_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id
    `, [event.id, event.data.accountId, event.data.messageId, event.occurredAt]);
    if (inserted.rowCount) {
      await client.query('INSERT INTO webhook_receiver_jobs(event_id) VALUES ($1)', [event.id]);
    }
    await client.query('COMMIT');
    return { duplicate: inserted.rowCount === 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

export function createReceiver({ pool, secret }) {
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/mailflow') { res.writeHead(404).end(); return; }
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > BODY_LIMIT) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!verifyWebhook({ secret, timestamp: req.headers['x-mailflow-timestamp'], signature: req.headers['x-mailflow-signature'], body })) {
        res.writeHead(401).end(); return;
      }
      let event;
      try { event = parseWebhook(body, req.headers['x-mailflow-event-id']); }
      catch { res.writeHead(400).end(); return; }
      await acceptWebhook(pool, event);
      res.writeHead(204).end();
    } catch {
      // Do not log incoming payloads, secrets, URLs or database errors.
      res.writeHead(503).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.MAILFLOW_WEBHOOK_SECRET;
  if (!secret || !process.env.DATABASE_URL) throw new Error('Set MAILFLOW_WEBHOOK_SECRET and DATABASE_URL');
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await initializeReceiver(pool);
  const server = createReceiver({ pool, secret });
  server.listen(8787, '127.0.0.1', () => console.log('Webhook receiver listening on loopback port 8787'));
}
