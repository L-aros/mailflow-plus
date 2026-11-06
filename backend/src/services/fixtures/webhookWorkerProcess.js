// Test-only subprocess transport. Production still refuses loopback targets.
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { createWebhookWorker } from '../webhooks.js';

const pool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
const worker = createWebhookWorker({ pool, send: async ({ url, secret, eventId, body, timestamp }) => {
  const signature = createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
  const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(2000), headers: {
    'content-type': 'application/json', 'x-mailflow-event-id': eventId,
    'x-mailflow-timestamp': timestamp, 'x-mailflow-signature': 'v1=' + signature,
  } });
  if (process.env.MAILFLOW_TEST_CRASH_AFTER_ACK === '1') process.exit(17);
  return { statusCode: response.status };
} });
try { await worker.runOnce(); }
finally { await worker.stop(); await pool.end(); }
