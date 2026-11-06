import 'express-async-errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import session from 'express-session';

const state = vi.hoisted(() => ({ pool: null, counters: new Map() }));
vi.mock('./db.js', () => ({
  pool: { query: (...args) => state.pool.query(...args), connect: () => state.pool.connect() },
  query: (...args) => state.pool.query(...args),
  withTransaction: async fn => {
    const client = await state.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  },
}));
vi.mock('./redis.js', () => ({ redisClient: {
  async incr(key) {
    const item = state.counters.get(key) || { count: 0, expires: 0 };
    item.count++;
    state.counters.set(key, item);
    return item.count;
  },
  async pExpire(key, ms) { state.counters.get(key).expires = Date.now() + ms; },
  async pTTL(key) { return (state.counters.get(key)?.expires || 0) - Date.now(); },
  async del(key) { state.counters.delete(key); },
} }));
vi.mock('./authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('./lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { createWebhookService, createWebhookWorker, webhookBackoffMs, webhookPayload, WEBHOOK_MAX_ATTEMPTS } from './webhooks.js';
import { createWebhookRouter, webhookRequestErrorHandler } from '../routes/webhooks.js';
import { mountApiAuth } from '../middleware/apiChain.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import { generateToken, hashToken, invalidateApiTokenSettingsCache, resetTokenUseForTests } from './apiTokens.js';
import { decrypt } from './encryption.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const FOREIGN = '10000000-0000-4000-8000-000000000002';
const DISABLED = '10000000-0000-4000-8000-000000000003';
const TARGET = 'https://receiver.example.test/private-path?key=fixture-url-secret';

describe('webhook stable contract', () => {
  it('serializes a minimal UTC event with a v1 resource locator and stable event ID', () => {
    const value = { event_id: 'event', account_id: 'account', message_id: 'message', occurred_at: '2026-11-07T00:00:00+08:00', body: 'never', subject: 'never' };
    expect(JSON.parse(webhookPayload(value))).toEqual({ id: 'event', type: 'message.received', occurredAt: '2026-11-06T16:00:00.000Z',
      data: { accountId: 'account', messageId: 'message', url: '/api/v1/messages/message' } });
    expect(webhookPayload(value)).toBe(webhookPayload(value));
  });
  it('uses exponential retry delays capped at one hour', () => {
    expect(Array.from({ length: 9 }, (_, n) => webhookBackoffMs(n + 1))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
  });
});

// Real PostgreSQL, including the shipping migration and independent pooled connections.
// The validator and send boundary are explicit substitutes: no external DNS/HTTP is used here.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('webhooks PostgreSQL worker and browser HTTP', () => {
  const schema = `webhook_test_${randomUUID().replaceAll('-', '')}`;
  let admin, server, base, service, validateTarget, readToken;
  let eventNumber = 0;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '39'.repeat(32);
    admin = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    state.pool = new pg.Pool({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL, options: `-c search_path=${schema},public`, application_name: schema, max: 8 });
    await state.pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY, username text NOT NULL);
      CREATE TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE oidc_providers (id uuid PRIMARY KEY);
      CREATE TABLE system_settings (key text PRIMARY KEY, value text);
    `);
    await state.pool.query(readFileSync(new URL('../../migrations/0076_webhooks.sql', import.meta.url), 'utf8'));
    await state.pool.query(readFileSync(new URL('../../migrations/0074_api_tokens.sql', import.meta.url), 'utf8'));
    validateTarget = vi.fn(async value => value);
    service = createWebhookService({ pool: state.pool, validateTarget });
    const app = express();
    mountApiAuth(app, session(buildSessionOptions(new session.MemoryStore(), 'webhook-fixture-session-secret'.padEnd(40, 'x'))));
    app.use('/api/webhooks', webhookRequestErrorHandler);
    app.get('/fixture-login/:id', (req, res) => {
      req.session.userId = req.params.id;
      req.session.locked = req.query.locked === '1';
      res.json({ ok: true });
    });
    app.use('/api/webhooks', createWebhookRouter(service));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await state.pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  beforeEach(async () => {
    await state.pool.query('TRUNCATE users CASCADE');
    await state.pool.query(`INSERT INTO users VALUES ($1, 'owner'), ($2, 'other')`, [OWNER, OTHER]);
    await state.pool.query(`INSERT INTO email_accounts VALUES ($1,$4,true), ($2,$5,true), ($3,$4,false)`, [ACCOUNT, FOREIGN, DISABLED, OWNER, OTHER]);
    await state.pool.query("UPDATE system_settings SET value = 'true' WHERE key = 'api_tokens_enabled'");
    state.counters.clear();
    invalidateApiTokenSettingsCache();
    resetTokenUseForTests();
    validateTarget.mockReset().mockImplementation(async value => value);
    readToken = generateToken();
    await state.pool.query(`INSERT INTO api_tokens (user_id,name,token_hash,scopes,expires_at,confirmed_with)
      VALUES ($1,'fixture reader',$2,'["read"]',NOW() + interval '1 day','password')`, [OWNER, hashToken(readToken)]);
  });

  const create = (overrides = {}, user = OWNER) => service.create(user, { name: 'Fixture receiver', accountId: ACCOUNT, url: TARGET, ...overrides });
  const enqueue = async (subscriptionId, { client = state.pool, user = OWNER, account = ACCOUNT, occurredAt = '2026-11-07T00:00:00Z' } = {}) => {
    const event = randomUUID();
    const message = randomUUID();
    await client.query(`INSERT INTO webhook_events (id,user_id,account_id,message_id,uid_validity,uid,occurred_at)
      VALUES ($1,$2,$3,$4,1,$5,$6)`, [event, user, account, message, ++eventNumber, occurredAt]);
    const { rows } = await client.query('INSERT INTO webhook_deliveries (event_id,subscription_id) VALUES ($1,$2) RETURNING *', [event, subscriptionId]);
    return { ...rows[0], message, event };
  };
  const delivery = async id => (await state.pool.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id])).rows[0];
  const due = id => state.pool.query("UPDATE webhook_deliveries SET next_attempt_at = NOW() - interval '1 second' WHERE id = $1", [id]);
  const cookie = async (id = OWNER, locked = false) => {
    const response = await fetch(`${base}/fixture-login/${id}${locked ? '?locked=1' : ''}`);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (path = '', { method = 'GET', sessionCookie, token, body, rawBody, csrf = true } = {}) => {
    const response = await fetch(`${base}/api/webhooks${path}`, { method, headers: {
      ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    }, ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };

  it('encrypts target and signing secret, revealing the secret only at creation/rotation', async () => {
    const created = await create();
    expect(created.secret).toMatch(/^mwhsec_[A-Za-z0-9_-]{43}$/);
    const stored = (await state.pool.query('SELECT * FROM webhook_subscriptions')).rows[0];
    expect(stored.target_url).toMatch(/^enc:v1:/);
    expect(stored.signing_secret).toMatch(/^enc:v1:/);
    expect(decrypt(stored.target_url)).toBe(TARGET);
    expect(decrypt(stored.signing_secret)).toBe(created.secret);
    const list = await service.list(OWNER);
    expect(list).toHaveLength(1);
    expect(list[0].targetOrigin).toBe('https://receiver.example.test');
    expect(JSON.stringify(list)).not.toContain('fixture-url-secret');
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(await service.list(OTHER)).toEqual([]);
    const rotated = await service.rotate(OWNER, created.subscription.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(decrypt((await state.pool.query('SELECT signing_secret FROM webhook_subscriptions')).rows[0].signing_secret)).toBe(rotated.secret);
  });

  it('rejects foreign, missing and disabled accounts before resolving a target', async () => {
    for (const accountId of [FOREIGN, DISABLED, randomUUID()]) {
      await expect(create({ accountId })).rejects.toMatchObject({ status: 404 });
    }
    expect(validateTarget).not.toHaveBeenCalled();
    validateTarget.mockRejectedValueOnce(new Error(TARGET));
    await expect(create()).rejects.toMatchObject({ status: 400, message: 'Target must be a public HTTP(S) URL' });
    expect(await service.list(OWNER)).toEqual([]);
  });

  it('serializes the ten-subscription quota across concurrent creates', async () => {
    for (let i = 0; i < 9; i++) await create({ name: `Fixture ${i}` });
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected').reason).toMatchObject({ status: 400 });
    expect(await service.list(OWNER)).toHaveLength(10);
  });

  it('reclaims a deleted quota slot while serializing concurrent deletes and creates', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id);
    for (let i = 1; i < 10; i++) await create({ name: `Fixture ${i}` });
    const blocker = await state.pool.connect();
    let removing, creating;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [OWNER]);
      removing = service.remove(OWNER, created.subscription.id);
      await vi.waitFor(async () => {
        const { rows } = await state.pool.query(`SELECT count(*) FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock' AND query = 'SELECT id FROM users WHERE id = $1 FOR UPDATE'`, [schema]);
        expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1);
      });
      creating = Promise.allSettled([create({ name: 'Replacement one' }), create({ name: 'Replacement two' })]);
      await blocker.query('COMMIT');
      await removing;
      const results = await creating;
      expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(value => value.status === 'rejected').reason).toMatchObject({ status: 400 });
      expect(await service.list(OWNER)).toHaveLength(10);
      expect(await delivery(item.id)).toBeUndefined();
      expect((await state.pool.query('SELECT id FROM webhook_events WHERE id = $1', [item.event])).rows).toHaveLength(1);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await Promise.allSettled([removing, creating].filter(Boolean));
    }
  });

  it('gates browser management with session, CSRF, screen lock and the unchanged token allowlist', async () => {
    expect((await call()).status).toBe(401);
    const ownerCookie = await cookie();
    expect((await call('', { method: 'POST', sessionCookie: ownerCookie, csrf: false, body: { name: 'Fixture', accountId: ACCOUNT, url: TARGET } })).status).toBe(403);
    expect((await call('', { sessionCookie: await cookie(OWNER, true) })).status).toBe(423);
    const created = await call('', { method: 'POST', sessionCookie: ownerCookie, body: { name: 'Fixture', accountId: ACCOUNT, url: TARGET } });
    expect(created.status).toBe(201);
    expect(created.cache).toBe('no-store');
    const id = created.body.subscription.id;
    for (const [path, method] of [['', 'GET'], ['', 'POST'], [`/${id}`, 'PATCH'], [`/${id}`, 'DELETE'], [`/${id}/rotate`, 'POST'], [`/${id}/deliveries`, 'GET'], [`/${id}/deliveries/${randomUUID()}/retry`, 'POST']]) {
      expect((await call(path, { method, token: readToken, sessionCookie: ownerCookie, ...(method === 'GET' ? {} : { body: {} }) })).status).toBe(403);
    }
    const otherCookie = await cookie(OTHER);
    for (const [path, method, body] of [[`/${id}`, 'PATCH', { enabled: false }], [`/${id}`, 'DELETE', {}], [`/${id}/rotate`, 'POST', {}], [`/${id}/deliveries`, 'GET'], [`/${id}/deliveries/${randomUUID()}/retry`, 'POST', {}]]) {
      expect((await call(path, { method, body, sessionCookie: otherCookie })).status).toBe(404);
    }
    expect((await call('', { sessionCookie: otherCookie })).body.subscriptions).toEqual([]);
    expect((await call('', { method: 'POST', sessionCookie: ownerCookie, body: { name: 'Foreign', accountId: FOREIGN, url: TARGET } })).status).toBe(404);
    expect((await call(`/${id}`, { method: 'PATCH', sessionCookie: ownerCookie, body: { enabled: false, url: TARGET } })).status).toBe(400);
    expect((await call('/bad-uuid', { method: 'PATCH', sessionCookie: ownerCookie, body: { enabled: false } })).status).toBe(400);
    expect((await call(`/${id}`, { method: 'DELETE', sessionCookie: ownerCookie, csrf: false })).status).toBe(403);
    expect((await call(`/${id}`, { method: 'DELETE', sessionCookie: ownerCookie })).status).toBe(200);
    expect((await call(`/${id}`, { method: 'DELETE', sessionCookie: ownerCookie })).status).toBe(404);
  });

  it('rejects malformed management bodies and never writes them to the queue or subscription table', async () => {
    const ownerCookie = await cookie();
    for (const body of [null, [], {}, { name: '', accountId: ACCOUNT, url: TARGET },
      { name: 'Fixture', accountId: 'bad-uuid', url: TARGET },
      { name: 'Fixture\nreceiver', accountId: ACCOUNT, url: TARGET },
      { name: 'Fixture', accountId: ACCOUNT, url: TARGET, secret: 'not-accepted' }]) {
      expect((await call('', { method: 'POST', sessionCookie: ownerCookie, body })).status).toBe(400);
    }
    expect(await service.list(OWNER)).toEqual([]);
    expect(Number((await state.pool.query('SELECT count(*) FROM webhook_deliveries')).rows[0].count)).toBe(0);
    const created = await create();
    expect((await call(`/${created.subscription.id}`, { method: 'PATCH', sessionCookie: ownerCookie, body: { enabled: 'false' } })).status).toBe(400);
    expect((await call(`/${created.subscription.id}/rotate`, { method: 'POST', sessionCookie: ownerCookie, body: { enabled: true } })).status).toBe(400);
  });

  it('redacts pre-route JSON and size errors without logging credential-bearing request bodies', async () => {
    const ownerCookie = await cookie();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const malformed = await call('', { method: 'POST', sessionCookie: ownerCookie,
        rawBody: `{"url":"${TARGET}","secret":"fixture-signing-secret"` });
      expect(malformed).toMatchObject({ status: 400, body: { error: 'Invalid webhook JSON' } });
      expect(JSON.stringify(malformed)).not.toContain('fixture-url-secret');
      expect(JSON.stringify(malformed)).not.toContain('fixture-signing-secret');
      const large = await call('', { method: 'POST', sessionCookie: ownerCookie,
        body: { url: TARGET, secret: 's'.repeat(2 * 1024 * 1024) } });
      // The shared body parser already answers its 1 MiB refusal safely, before our handler.
      expect(large.status).toBe(413);
      expect(large.body.error).toMatch(/^Request too large\./);
      expect(JSON.stringify(large)).not.toContain('fixture-url-secret');
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('delivers only committed rows and a fresh worker resumes persisted pending work', async () => {
    const created = await create();
    const send = vi.fn(async () => ({ statusCode: 204 }));
    const worker = createWebhookWorker({ pool: state.pool, send });
    const client = await state.pool.connect();
    try {
      await client.query('BEGIN');
      await enqueue(created.subscription.id, { client });
      expect(await worker.runOnce()).toBe(false);
      await client.query('ROLLBACK');
      expect(await worker.runOnce()).toBe(false);
      await client.query('BEGIN');
      const item = await enqueue(created.subscription.id, { client });
      expect(await worker.runOnce()).toBe(false);
      await client.query('COMMIT');
      await worker.stop();
      const restarted = createWebhookWorker({ pool: state.pool, send });
      expect(await restarted.runOnce()).toBe(true);
      expect((await delivery(item.id)).status).toBe('delivered');
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][0];
      expect(sent.secret).toBe(created.secret);
      expect(sent.timeoutMs).toBe(10_000);
      expect(JSON.parse(sent.body)).toMatchObject({ id: item.event, data: { messageId: item.message, accountId: ACCOUNT } });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('persists safe failures, future backoff and the eight-attempt terminal state', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id);
    const send = vi.fn(async () => { throw Object.assign(new Error(`untrusted error ${TARGET} body-and-secret`), { code: 'untrusted' }); });
    const worker = createWebhookWorker({ pool: state.pool, send });
    const before = Date.now();
    await worker.runOnce();
    let row = await delivery(item.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'network_error', last_status: null });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(await worker.runOnce()).toBe(false);
    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i++) { await due(item.id); await worker.runOnce(); }
    row = await delivery(item.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 8, last_error: 'network_error' });
    expect(send).toHaveBeenCalledTimes(8);
    expect(await worker.runOnce()).toBe(false);
    const { deliveries: listed } = await service.deliveries(OWNER, created.subscription.id);
    expect(listed[0]).toMatchObject({ status: 'failed', attempts: 8, lastError: 'network_error' });
    expect(JSON.stringify(listed)).not.toContain(TARGET);
    expect((await service.list(OWNER))[0]).toMatchObject({ failed: 1, pending: 0 });
  });

  it('retries terminal failures using the same event/body and records non-2xx status', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id);
    const send = vi.fn(async () => ({ statusCode: 503 }));
    const worker = createWebhookWorker({ pool: state.pool, send });
    await state.pool.query('UPDATE webhook_deliveries SET attempts = 7 WHERE id = $1', [item.id]);
    await worker.runOnce();
    expect(await delivery(item.id)).toMatchObject({ status: 'failed', last_error: 'http_error', last_status: 503 });
    await expect(service.retry(OTHER, created.subscription.id, item.id)).rejects.toMatchObject({ status: 404 });
    const another = await create({ name: 'Other owned subscription' });
    await expect(service.retry(OWNER, another.subscription.id, item.id)).rejects.toMatchObject({ status: 404 });
    await service.retry(OWNER, created.subscription.id, item.id);
    send.mockImplementation(async () => ({ statusCode: 200 }));
    await worker.runOnce();
    expect(await delivery(item.id)).toMatchObject({ status: 'delivered', attempts: 1, last_error: null, last_status: 200 });
    expect(send.mock.calls[0][0].body).toBe(send.mock.calls[1][0].body);
    expect(send.mock.calls[0][0].eventId).toBe(send.mock.calls[1][0].eventId);
    await expect(service.retry(OWNER, created.subscription.id, item.id)).rejects.toMatchObject({ status: 404 });
  });

  it('suspends pending work while disabled and sends a rotated key when resumed', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id);
    const send = vi.fn(async () => ({ statusCode: 202 }));
    const worker = createWebhookWorker({ pool: state.pool, send });
    await service.setEnabled(OWNER, created.subscription.id, false);
    expect(await worker.runOnce()).toBe(false);
    expect((await delivery(item.id)).attempts).toBe(0);
    const rotated = await service.rotate(OWNER, created.subscription.id);
    await service.setEnabled(OWNER, created.subscription.id, true);
    await worker.runOnce();
    expect(send.mock.calls[0][0].secret).toBe(rotated.secret);
    expect(send.mock.calls[0][0].secret).not.toBe(created.secret);
  });

  it('makes disable wait for an in-flight request to finish', async () => {
    const created = await create();
    await enqueue(created.subscription.id);
    let releaseSend, startedSend;
    const started = new Promise(resolve => { startedSend = resolve; });
    const send = () => new Promise(resolve => { releaseSend = resolve; startedSend(); });
    const worker = createWebhookWorker({ pool: state.pool, send });
    const working = worker.runOnce();
    await started;
    let disabled = false;
    const disabling = service.setEnabled(OWNER, created.subscription.id, false).then(() => { disabled = true; });
    // A database round trip proves disable has had an opportunity to acquire its lock.
    await state.pool.query('SELECT 1');
    expect(disabled).toBe(false);
    releaseSend({ statusCode: 200 });
    await Promise.all([working, disabling]);
    expect(disabled).toBe(true);
  });

  it('waits for in-flight delivery before deleting and retains the event record', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id);
    let releaseSend, startedSend;
    const started = new Promise(resolve => { startedSend = resolve; });
    const worker = createWebhookWorker({ pool: state.pool, send: () => new Promise(resolve => {
      releaseSend = resolve; startedSend();
    }) });
    const working = worker.runOnce();
    await started;
    let removed = false;
    const removing = service.remove(OWNER, created.subscription.id).then(() => { removed = true; });
    await state.pool.query('SELECT 1');
    expect(removed).toBe(false);
    releaseSend({ statusCode: 200 });
    await Promise.all([working, removing]);
    expect(await service.list(OWNER)).toEqual([]);
    expect(await delivery(item.id)).toBeUndefined();
    expect((await state.pool.query('SELECT id FROM webhook_events WHERE id = $1', [item.event])).rows).toHaveLength(1);
    expect(await worker.runOnce()).toBe(false);
  });

  it('finds and retries old failures beyond recent successes and paginates more than 100 failures', async () => {
    const created = await create();
    const old = await enqueue(created.subscription.id);
    await state.pool.query(`UPDATE webhook_deliveries SET status = 'failed', attempts = 8,
      last_error = 'network_error', created_at = NOW() - interval '1 day' WHERE id = $1`, [old.id]);
    // Bulk fixture rows retain distinct event identities and real foreign-key constraints.
    await state.pool.query(`WITH events AS (
      INSERT INTO webhook_events (user_id, account_id, message_id, uid_validity, uid)
      SELECT $1,$2,gen_random_uuid(),2,n FROM generate_series(1,202) n RETURNING id,uid
    ) INSERT INTO webhook_deliveries (event_id,subscription_id,status,attempts,last_error)
      SELECT id,$3,CASE WHEN uid <= 101 THEN 'delivered' ELSE 'failed' END,8,
        CASE WHEN uid <= 101 THEN NULL ELSE 'timeout' END FROM events`, [OWNER, ACCOUNT, created.subscription.id]);
    const ownerCookie = await cookie();
    const all = await call(`/${created.subscription.id}/deliveries`, { sessionCookie: ownerCookie });
    expect(all.body.deliveries).toHaveLength(100);
    expect(all.body.deliveries.map(value => value.id)).not.toContain(old.id);
    const first = await call(`/${created.subscription.id}/deliveries?status=failed`, { sessionCookie: ownerCookie });
    expect(first.status).toBe(200);
    expect(first.body.deliveries).toHaveLength(100);
    expect(first.body.deliveries.every(value => value.status === 'failed')).toBe(true);
    expect(first.body.pagination).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 100 });
    const second = await call(`/${created.subscription.id}/deliveries?status=failed&offset=100`, { sessionCookie: ownerCookie });
    expect(second.body.deliveries).toHaveLength(2);
    expect(second.body.deliveries.map(value => value.id)).toContain(old.id);
    expect(second.body.pagination).toEqual({ offset: 100, limit: 100, hasMore: false, nextOffset: null });
    expect(new Set([...first.body.deliveries, ...second.body.deliveries].map(value => value.id)).size).toBe(102);
    const retry = await call(`/${created.subscription.id}/deliveries/${old.id}/retry`, { method: 'POST', sessionCookie: ownerCookie, body: {} });
    expect(retry.status).toBe(200);
    expect(await delivery(old.id)).toMatchObject({ status: 'pending', attempts: 0 });
    const foreignCookie = await cookie(OTHER);
    expect((await call(`/${created.subscription.id}/deliveries?status=failed&offset=100`, { sessionCookie: foreignCookie })).status).toBe(404);
  });

  it('rejects unknown, repeated, malformed and unsafe delivery pagination queries', async () => {
    const created = await create();
    const ownerCookie = await cookie();
    for (const query of ['status=all', 'status=failed&status=failed', 'status[x]=failed', 'offset=1&offset=2',
      'offset=-1', 'offset=01', 'offset=1e2', 'offset=1.1', 'offset=9007199254740992', 'offset[x]=1', 'other=1']) {
      expect((await call(`/${created.subscription.id}/deliveries?${query}`, { sessionCookie: ownerCookie })).status).toBe(400);
    }
    const end = await call(`/${created.subscription.id}/deliveries?offset=9007199254740991`, { sessionCookie: ownerCookie });
    expect(end).toMatchObject({ status: 200, body: { deliveries: [], pagination: { hasMore: false, nextOffset: null } } });
  });

  it('claims distinct rows under concurrent workers and fences replaced/expired leases', async () => {
    const created = await create();
    const first = await enqueue(created.subscription.id);
    const second = await enqueue(created.subscription.id);
    const send = vi.fn(async () => ({ statusCode: 200 }));
    const one = createWebhookWorker({ pool: state.pool, send });
    const two = createWebhookWorker({ pool: state.pool, send });
    const [claimedOne, claimedTwo] = await Promise.all([one.claim(), two.claim()]);
    expect(claimedOne.id).not.toBe(claimedTwo.id);
    expect(new Set([claimedOne.id, claimedTwo.id])).toEqual(new Set([first.id, second.id]));
    await state.pool.query("UPDATE webhook_deliveries SET lease_until = NOW() - interval '1 second' WHERE id = $1", [claimedOne.id]);
    const replacement = await two.claim();
    expect(replacement.id).toBe(claimedOne.id);
    expect(replacement.lease_token).not.toBe(claimedOne.lease_token);
    expect(await one.deliver(claimedOne)).toBe(false);
    await Promise.all([two.deliver(replacement), two.deliver(claimedTwo)]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map(([request]) => request.eventId)).size).toBe(2);
    expect((await delivery(replacement.id)).attempts).toBe(2);
  });

  it('marks an abandoned last lease failed and preserves it for manual retry', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id);
    await state.pool.query(`UPDATE webhook_deliveries SET status = 'processing', attempts = 8,
      lease_token = $2, lease_until = NOW() - interval '1 second' WHERE id = $1`, [item.id, randomUUID()]);
    const send = vi.fn();
    const worker = createWebhookWorker({ pool: state.pool, send });
    expect(await worker.runOnce()).toBe(false);
    expect(await delivery(item.id)).toMatchObject({ status: 'failed', attempts: 8, last_error: 'lease_expired', lease_token: null });
    expect(send).not.toHaveBeenCalled();
    await service.retry(OWNER, created.subscription.id, item.id);
    expect(await delivery(item.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('refuses mismatched event ownership and disabled/deleted mailboxes at dispatch', async () => {
    const created = await create();
    const item = await enqueue(created.subscription.id, { user: OTHER, account: FOREIGN });
    const send = vi.fn();
    const worker = createWebhookWorker({ pool: state.pool, send });
    expect(await worker.runOnce()).toBe(false);
    await state.pool.query('UPDATE webhook_events SET user_id = $2, account_id = $3 WHERE id = $1', [item.event, OWNER, ACCOUNT]);
    await state.pool.query('UPDATE email_accounts SET enabled = false WHERE id = $1', [ACCOUNT]);
    expect(await worker.runOnce()).toBe(false);
    await state.pool.query('DELETE FROM email_accounts WHERE id = $1', [ACCOUNT]);
    expect(await worker.runOnce()).toBe(false);
    expect(await delivery(item.id)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not promise arrival ordering; the receiver can deduplicate stable event IDs', async () => {
    const created = await create();
    const later = await enqueue(created.subscription.id, { occurredAt: '2026-11-07T02:00:00Z' });
    const earlier = await enqueue(created.subscription.id, { occurredAt: '2026-11-07T01:00:00Z' });
    const send = vi.fn(async () => ({ statusCode: 200 }));
    const worker = createWebhookWorker({ pool: state.pool, send });
    await worker.runOnce(); await worker.runOnce();
    expect(send.mock.calls.map(([value]) => value.eventId)).toEqual([later.event, earlier.event]);
    expect(send.mock.calls.map(([value]) => JSON.parse(value.body).occurredAt)).toEqual(['2026-11-07T02:00:00.000Z', '2026-11-07T01:00:00.000Z']);
  });
});
