import { randomBytes, randomUUID } from 'node:crypto';
import { pool as defaultPool } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { isUuid } from '../utils/uuid.js';
import { sendWebhook, validateWebhookTarget } from './webhookTransport.js';

export const MAX_WEBHOOK_SUBSCRIPTIONS = 10;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_LEASE_MS = 60_000;
const SAFE_FAILURES = new Set(['target_rejected', 'timeout', 'network_error', 'redirect_rejected', 'http_error']);

export class WebhookError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function webhookBackoffMs(attempts) {
  return Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function webhookPayload(event) {
  return JSON.stringify({
    id: event.event_id,
    type: 'message.received',
    occurredAt: new Date(event.occurred_at).toISOString(),
    data: {
      accountId: event.account_id,
      messageId: event.message_id,
      url: `/api/v1/messages/${event.message_id}`,
    },
  });
}

const secretValue = () => `mwhsec_${randomBytes(32).toString('base64url')}`;
const notFound = () => new WebhookError(404, 'Webhook not found');

function subscriptionView(row) {
  const url = decrypt(row.target_url);
  // Lists never reveal a URL path/query (which can itself contain a receiver credential).
  let targetOrigin = null;
  try { targetOrigin = new URL(url).origin; } catch { /* corrupted credential stays hidden */ }
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    targetOrigin,
    enabled: row.enabled,
    createdAt: row.created_at,
    pending: Number(row.pending || 0),
    failed: Number(row.failed || 0),
    oldestPendingAt: row.oldest_pending_at || null,
  };
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Browser management and the worker share this storage boundary. Injecting a pool/validator
// is for isolated tests; no environment variable can relax the production network policy.
export function createWebhookService({ pool = defaultPool, validateTarget = validateWebhookTarget } = {}) {
  async function owned(client, userId, id, lock = false) {
    const { rows } = await client.query(
      `SELECT * FROM webhook_subscriptions WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [id, userId],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  return {
    async list(userId) {
      const { rows } = await pool.query(`
        SELECT s.*, counts.pending, counts.failed, counts.oldest_pending_at
        FROM webhook_subscriptions s
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE status IN ('pending', 'processing')) AS pending,
                 count(*) FILTER (WHERE status = 'failed') AS failed,
                 min(created_at) FILTER (WHERE status IN ('pending', 'processing')) AS oldest_pending_at
          FROM webhook_deliveries WHERE subscription_id = s.id
        ) counts ON true
        WHERE s.user_id = $1 ORDER BY s.created_at, s.id`, [userId]);
      return rows.map(subscriptionView);
    },

    async create(userId, { name, accountId, url } = {}) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /\p{Cc}/u.test(name)) {
        throw new WebhookError(400, 'Choose a webhook name of 1–100 characters');
      }
      if (!isUuid(accountId)) throw new WebhookError(400, 'Invalid accountId');
      const account = await pool.query('SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = true', [accountId, userId]);
      if (!account.rows[0]) throw new WebhookError(404, 'Account not found');
      let target;
      try { target = await validateTarget(url); }
      catch { throw new WebhookError(400, 'Target must be a public HTTP(S) URL'); }
      const secret = secretValue();
      return transaction(pool, async client => {
        // Serialize the quota with other creates for this user, rather than count then race.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const count = await client.query('SELECT count(*) AS count FROM webhook_subscriptions WHERE user_id = $1', [userId]);
        if (Number(count.rows[0].count) >= MAX_WEBHOOK_SUBSCRIPTIONS) {
          throw new WebhookError(400, `You already have ${MAX_WEBHOOK_SUBSCRIPTIONS} webhooks`);
        }
        const { rows } = await client.query(`
          INSERT INTO webhook_subscriptions (id, user_id, account_id, name, target_url, signing_secret)
          SELECT $1, $2, a.id, $4, $5, $6 FROM email_accounts a
          WHERE a.id = $3 AND a.user_id = $2 AND a.enabled = true RETURNING *`,
        [randomUUID(), userId, accountId, name.trim(), encrypt(target), encrypt(secret)]);
        if (!rows[0]) throw new WebhookError(404, 'Account not found');
        return { subscription: subscriptionView(rows[0]), secret };
      });
    },

    async setEnabled(userId, id, enabled) {
      if (typeof enabled !== 'boolean') throw new WebhookError(400, 'enabled must be a boolean');
      return transaction(pool, async client => {
        await owned(client, userId, id, true);
        const { rows } = await client.query(`UPDATE webhook_subscriptions SET enabled = $3, updated_at = NOW()
          WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId, enabled]);
        return subscriptionView(rows[0]);
      });
    },

    async rotate(userId, id) {
      return transaction(pool, async client => {
        await owned(client, userId, id, true);
        const secret = secretValue();
        await client.query(`UPDATE webhook_subscriptions SET signing_secret = $3, updated_at = NOW()
          WHERE id = $1 AND user_id = $2`, [id, userId, encrypt(secret)]);
        return { secret };
      });
    },

    async remove(userId, id) {
      return transaction(pool, async client => {
        // Creates and deletes serialize their quota changes on the same owner row.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        await owned(client, userId, id, true);
        await client.query('DELETE FROM webhook_subscriptions WHERE id = $1 AND user_id = $2', [id, userId]);
        // Delivery rows cascade; events retain their identity for other subscriptions.
        return { ok: true };
      });
    },

    async deliveries(userId, id, { status, offset = 0 } = {}) {
      if ((status !== undefined && status !== 'failed') || !Number.isSafeInteger(offset) || offset < 0) {
        throw new WebhookError(400, 'Invalid delivery filter or offset');
      }
      await owned(pool, userId, id);
      const { rows } = await pool.query(`
        SELECT d.id, d.event_id AS "eventId", d.status, d.attempts,
               d.next_attempt_at AS "nextAttemptAt", d.last_error AS "lastError",
               d.last_status AS "lastStatus", d.created_at AS "createdAt", d.delivered_at AS "deliveredAt"
        FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
        WHERE s.id = $1 AND s.user_id = $2${status === 'failed' ? " AND d.status = 'failed'" : ''}
        ORDER BY d.created_at DESC, d.id DESC LIMIT 101 OFFSET $3`, [id, userId, offset]);
      const hasMore = rows.length > 100;
      return {
        deliveries: rows.slice(0, 100),
        pagination: { offset, limit: 100, hasMore, nextOffset: hasMore && Number.isSafeInteger(offset + 100) ? offset + 100 : null },
      };
    },

    async retry(userId, id, deliveryId) {
      await owned(pool, userId, id);
      const { rows } = await pool.query(`
        UPDATE webhook_deliveries d SET status = 'pending', attempts = 0, next_attempt_at = NOW(),
          lease_token = NULL, lease_until = NULL, updated_at = NOW()
        FROM webhook_subscriptions s
        WHERE d.id = $3 AND d.subscription_id = s.id AND s.id = $1 AND s.user_id = $2
          AND d.status = 'failed' RETURNING d.id`, [id, userId, deliveryId]);
      if (!rows[0]) throw new WebhookError(404, 'Failed delivery not found');
      return { ok: true };
    },
  };
}

export const webhookService = createWebhookService();

// All durable state lives in PostgreSQL. The timer only polls; claims survive a crash.
// A process may stop after its receiver commits and before our commit: that is a duplicate,
// with the same event ID/body. Receivers must deduplicate that ID transactionally.
export function createWebhookWorker({ pool = defaultPool, send = sendWebhook, pollMs = 1000 } = {}) {
  let timer = null;
  let active = null;
  let stopping = false;

  async function claim() {
    // A final attempt that died has consumed its budget too. Keep its failure visible.
    await pool.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'lease_expired',
      lease_token = NULL, lease_until = NULL, updated_at = NOW()
      WHERE status = 'processing' AND lease_until <= NOW() AND attempts >= $1`, [WEBHOOK_MAX_ATTEMPTS]);
    const token = randomUUID();
    const { rows } = await pool.query(`
      WITH candidate AS (
        SELECT d.id FROM webhook_deliveries d
        JOIN webhook_subscriptions s ON s.id = d.subscription_id
        JOIN email_accounts a ON a.id = s.account_id AND a.user_id = s.user_id
        JOIN webhook_events e ON e.id = d.event_id AND e.user_id = s.user_id AND e.account_id = s.account_id
        WHERE s.enabled = true AND a.enabled = true AND d.attempts < $1
          AND ((d.status = 'pending' AND d.next_attempt_at <= NOW())
            OR (d.status = 'processing' AND d.lease_until <= NOW()))
        ORDER BY d.next_attempt_at, d.created_at, d.id
        FOR UPDATE OF d SKIP LOCKED LIMIT 1
      )
      UPDATE webhook_deliveries d SET status = 'processing', attempts = d.attempts + 1,
        lease_token = $2, lease_until = NOW() + ($3 * interval '1 millisecond'), updated_at = NOW()
      FROM candidate c WHERE d.id = c.id RETURNING d.id, d.lease_token`,
    [WEBHOOK_MAX_ATTEMPTS, token, WEBHOOK_LEASE_MS]);
    return rows[0];
  }

  async function deliver(item) {
    return transaction(pool, async client => {
      // Holding the subscription row while sending makes disable/rotation a clear boundary:
      // when management returns, any old-key/in-flight send has finished (at most 10 seconds).
      // Holding the delivery row also prevents an expired lease reclaim mid-request.
      // Lock subscription before delivery, as deletion does before cascading its rows.
      // Claims may change while waiting; the fenced delivery query below checks again.
      const subscription = await client.query(`
        SELECT s.id FROM webhook_subscriptions s JOIN webhook_deliveries d ON d.subscription_id = s.id
        WHERE d.id = $1 AND d.status = 'processing' AND d.lease_token = $2 AND d.lease_until > NOW()
        FOR UPDATE OF s`, [item.id, item.lease_token]);
      if (!subscription.rows[0]) return false;
      const { rows } = await client.query(`
        SELECT d.id, d.attempts, s.target_url, s.signing_secret, s.enabled,
               a.enabled AS account_enabled, e.id AS event_id, e.account_id, e.message_id, e.occurred_at
        FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
        JOIN email_accounts a ON a.id = s.account_id AND a.user_id = s.user_id
        JOIN webhook_events e ON e.id = d.event_id AND e.user_id = s.user_id AND e.account_id = s.account_id
        WHERE d.id = $1 AND d.status = 'processing' AND d.lease_token = $2 AND d.lease_until > NOW()
        FOR UPDATE OF d`, [item.id, item.lease_token]);
      const row = rows[0];
      if (!row) return false; // expired/replaced lease cannot finish another worker's claim
      if (!row.enabled || !row.account_enabled) {
        await client.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = attempts - 1,
          lease_token = NULL, lease_until = NULL, updated_at = NOW() WHERE id = $1 AND lease_token = $2`,
        [item.id, item.lease_token]);
        return false;
      }
      const url = decrypt(row.target_url);
      const secret = decrypt(row.signing_secret);
      let failure = null;
      let statusCode = null;
      if (!url || !secret) failure = 'credential_unavailable';
      else {
        try {
          const result = await send({ url, secret, eventId: row.event_id, body: webhookPayload(row),
            timestamp: String(Math.floor(Date.now() / 1000)), timeoutMs: WEBHOOK_TIMEOUT_MS });
          statusCode = result.statusCode;
          if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) failure = 'http_error';
        } catch (err) {
          failure = SAFE_FAILURES.has(err.code) ? err.code : 'network_error';
          if (Number.isInteger(err.statusCode) && err.statusCode >= 100 && err.statusCode <= 599) statusCode = err.statusCode;
        }
      }
      if (!failure) {
        await client.query(`UPDATE webhook_deliveries SET status = 'delivered', delivered_at = NOW(),
          last_error = NULL, last_status = $3, lease_token = NULL, lease_until = NULL, updated_at = NOW()
          WHERE id = $1 AND lease_token = $2 AND status = 'processing'`, [item.id, item.lease_token, statusCode]);
      } else {
        await client.query(`UPDATE webhook_deliveries SET status = $3, last_error = $4, last_status = $5,
          next_attempt_at = NOW() + ($6 * interval '1 millisecond'),
          lease_token = NULL, lease_until = NULL, updated_at = NOW()
          WHERE id = $1 AND lease_token = $2 AND status = 'processing'`,
        [item.id, item.lease_token, row.attempts >= WEBHOOK_MAX_ATTEMPTS ? 'failed' : 'pending',
          failure, statusCode, webhookBackoffMs(row.attempts)]);
      }
      return true;
    });
  }

  async function runOnce() {
    const item = await claim();
    if (!item) return false;
    await deliver(item);
    return true;
  }

  async function poll() {
    if (stopping || active) return;
    active = runOnce().catch(() => {
      // Never print raw errors: an HTTP client error can contain the credential-bearing URL.
      console.error('[webhooks] worker iteration failed; durable lease will recover');
    });
    try { await active; }
    finally {
      active = null;
      if (!stopping) { timer = setTimeout(poll, pollMs); timer.unref?.(); }
    }
  }

  return {
    runOnce,
    claim,
    deliver,
    start() {
      if (!stopping && (timer || active)) return;
      stopping = false;
      poll();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      timer = null;
      await active;
    },
  };
}
