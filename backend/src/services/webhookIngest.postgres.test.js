import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import pg from 'pg';

const h = vi.hoisted(() => ({ pool: null, bound: null, delayedQuery: null }));
vi.mock('./db.js', () => ({
  pool: { connect: (...args) => h.pool.connect(...args), query: (...args) => h.pool.query(...args) },
  query: (...args) => h.delayedQuery ? h.delayedQuery(...args) : (h.bound || h.pool).query(...args),
}));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./hostValidation.js', async importOriginal => ({ ...await importOriginal(),
  resolveForConnection: vi.fn(async () => ({ host: '93.184.216.34', servername: 'mail.example.test' })),
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: {
  hasActiveAsync: vi.fn(async () => false), runHook: vi.fn(async () => {}),
} }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn(async () => {}) }));
vi.mock('./inboxRules.js', () => ({
  applyBlockList: vi.fn(async messages => messages),
  applyInboxRules: vi.fn(async messages => ({ remaining: messages, mutedIds: new Set(messages.map(m => m.id)) })),
  newMailAlerts: vi.fn(() => ({ alertMessages: [], alertCount: 0, send: false })),
  newMailPushPayload: vi.fn(),
}));

import { ImapManager } from './imapManager.js';
import { ImapFlow } from 'imapflow';
import { runMigrations } from './migrations.js';
import { encrypt } from './encryption.js';
import { rememberDroppedRows, clearCarries } from './movedRowCarry.js';
import { createWebhookWorker, createWebhookService } from './webhooks.js';
import { pauseRestoredWebhooks } from './backup.js';
import { createReceiver, initializeReceiver } from '../../../docs/examples/webhook-receiver.mjs';

const exec = promisify(execFile);
const ADMIN_URL = process.env.MAILFLOW_TEST_DATABASE_URL;
const fixture = fileURLToPath(new URL('./fixtures/webhookWorkerProcess.js', import.meta.url));

describe.skipIf(!ADMIN_URL)('actual mail persistence with durable Webhook outbox', () => {
  const dbName = `mailflow_webhook_ingest_${randomBytes(4).toString('hex')}`;
  let admin, dbUrl, account, subscription, manager, receiver, receiverUrl;
  const secret = 'mwhsec_virtual_receiver_only';
  const message = (uid, read = true) => ({ uid, flags: new Set(read ? ['\\Seen'] : []),
    envelope: { messageId: `<virtual-${uid}@example.test>`, subject: 'Private subject fixture',
      from: [{ name: 'Private sender', address: 'sender@example.test' }],
      to: [{ address: 'reader@example.test' }], date: new Date('2026-01-01T00:00:00Z') },
    internalDate: new Date('2026-01-01T00:00:00Z'), headers: Buffer.from('X-Test: virtual\r\n'),
  });
  async function sync(uids, { next = Math.max(0, ...uids) + 1, validity = 77, folder = 'INBOX', read = true } = {}) {
    const client = {
      mailbox: { exists: uids.length, uidNext: next, uidValidity: validity }, noop: vi.fn(async () => {}),
      getMailboxLock: vi.fn(async () => ({ release() {} })),
      fetch: vi.fn(async function* (range) {
        let selected = uids;
        if (typeof range === 'string' && /^\d+:\*$/.test(range)) selected = uids.filter(uid => uid >= Number(range.split(':')[0]));
        for (const uid of selected) yield message(uid, read);
      }),
    };
    return manager.syncMessages(account, client, folder, 50, false, true);
  }
  const counts = async () => (await h.pool.query(`SELECT
    (SELECT count(*)::int FROM webhook_events) AS events,
    (SELECT count(*)::int FROM webhook_deliveries) AS deliveries`)).rows[0];
  async function subprocess(extra = {}) {
    return exec(process.execPath, [fixture], { env: { ...process.env,
      MAILFLOW_TEST_DATABASE_URL: dbUrl, ENCRYPTION_KEY: '7c'.repeat(32), ...extra }, timeout: 15000 });
  }
  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '7c'.repeat(32));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL); url.pathname = '/' + dbName; dbUrl = url.toString();
    h.pool = new pg.Pool({ connectionString: dbUrl, max: 8 });
    await runMigrations();
    await runMigrations(); // shipping runner is idempotent
    await initializeReceiver(h.pool);
    receiver = createReceiver({ pool: h.pool, secret });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/webhooks/mailflow`;
  }, 30000);
  afterAll(async () => {
    receiver?.closeAllConnections();
    if (receiver) await new Promise(resolve => receiver.close(resolve));
    await h.pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });
  beforeEach(async () => {
    h.bound = null; h.delayedQuery = null; clearCarries();
    await h.pool.query('TRUNCATE users, webhook_receiver_inbox CASCADE');
    const user = (await h.pool.query("INSERT INTO users(username) VALUES ('virtual-owner') RETURNING id")).rows[0];
    account = (await h.pool.query(`INSERT INTO email_accounts(user_id,name,email_address,imap_host)
      VALUES ($1,'Virtual mailbox','reader@example.test','mail.example.test') RETURNING *`, [user.id])).rows[0];
    subscription = (await h.pool.query(`INSERT INTO webhook_subscriptions(user_id,account_id,name,target_url,signing_secret)
      VALUES ($1,$2,'Virtual receiver',$3,$4) RETURNING *`,
    [user.id, account.id, encrypt(receiverUrl), encrypt(secret)])).rows[0];
    manager = Object.create(ImapManager.prototype);
    Object.assign(manager, { pluginFacade: {}, broadcast: vi.fn(), maybeClassifyNewMessage: vi.fn(),
      prefetchNewMessageBodies: vi.fn(async () => {}), upsertAutoContacts: vi.fn(async () => {}),
      backfillMessages: vi.fn(async () => {}), _bgConnSem: { acquire: async () => {}, release() {} } });
  });

  it('excludes first sync, historical backfill, non-INBOX and known moves; includes read and muted arrivals', async () => {
    await sync([5, 7], { next: 10 });
    expect(await counts()).toEqual({ events: 0, deliveries: 0 });
    await sync([8], { next: 10 }); // missing history, discovered after the first partial scan
    await sync([11], { next: 12, folder: 'Archive' });
    rememberDroppedRows('INBOX', [{ account_id: account.id, message_id: '<virtual-12@example.test>', date: new Date('2026-01-01T00:00:00Z') }]);
    await sync([12], { next: 13 });
    expect(await counts()).toEqual({ events: 0, deliveries: 0 });
    await sync([13], { next: 14 }); // already read on another device
    await sync([14], { next: 15, read: false }); // muted browser notification
    expect(await counts()).toEqual({ events: 2, deliveries: 2 });
    expect(manager.broadcast.mock.calls.some(([event]) => event.type === 'new_messages')).toBe(false);
    expect((await h.pool.query('SELECT uid FROM webhook_events ORDER BY uid')).rows.map(r => Number(r.uid))).toEqual([13, 14]);
  });

  it('uses an empty mailbox baseline and refuses unknown UIDNEXT/epoch and rebuilt history', async () => {
    await sync([], { next: 1 });
    await sync([1], { next: 2 });
    expect((await counts()).events).toBe(1);
    await sync([100], { validity: 78, next: 101 });
    await sync([101], { validity: 78, next: 102 });
    expect((await counts()).events).toBe(2);
    const before = (await counts()).events;
    await sync([103], { validity: 78, next: null });
    expect((await counts()).events).toBe(before);
  });

  it('independent backfill suppresses history and queues a post-baseline UID before sync can see it', async () => {
    await sync([], { next: 10 });
    const client = Object.assign(new EventEmitter(), {
      mailbox: { exists: 2, uidNext: 12, uidValidity: 77 }, usable: true,
      connect: async () => {}, close() {}, getMailboxLock: async () => ({ release() {} }),
      search: async () => [5, 11],
      fetch: async function* (range) { for (const uid of String(range).split(',').map(Number)) yield message(uid); },
    });
    ImapFlow.mockImplementation(function () { return client; });
    Object.assign(manager, { backfillRunning: new Set(), _secondaryConnectBlocked: () => false });
    await ImapManager.prototype.backfillMessages.call(manager, account, 'INBOX');
    expect((await h.pool.query('SELECT uid FROM messages ORDER BY uid')).rows.map(r => Number(r.uid))).toEqual([5, 11]);
    expect((await h.pool.query('SELECT uid FROM webhook_events')).rows.map(r => Number(r.uid))).toEqual([11]);
    await sync([5, 11], { next: 12 });
    expect((await counts()).events).toBe(1);
  });

  it('reserves a known local move once when independent persistence clients race', async () => {
    await sync([], { next: 10 });
    // Directly exercise the shared persistence boundary with two UIDs for one Message-ID.
    const { persistWebhookMessage } = await import('./webhookIngest.js');
    rememberDroppedRows('INBOX', [{ account_id: account.id, message_id: '<same@example.test>', category: 'primary' }]);
    const insert = `INSERT INTO messages(account_id,uid,folder,message_id) VALUES ($1,$2,'INBOX',$3)
      ON CONFLICT(account_id,uid,folder) DO UPDATE SET uid=EXCLUDED.uid RETURNING id,(xmax=0) AS is_new`;
    const results = await Promise.all([11, 12].map(uid => persistWebhookMessage({ validity: 77, next: 10 }, account,
      'INBOX', { uid, messageId: '<same@example.test>' }, insert, [account.id, uid, '<same@example.test>'])));
    expect(results.filter(r => r.rows[0].movedCarry)).toHaveLength(1);
    expect((await counts()).events).toBe(1);
  });

  it('same UID cannot emit an arrival when a carry holder is delayed behind another persistence client', async () => {
    await sync([], { next: 10 });
    const { persistWebhookMessage } = await import('./webhookIngest.js');
    rememberDroppedRows('INBOX', [{ account_id: account.id, message_id: '<same-uid@example.test>' }]);
    const insert = `INSERT INTO messages(account_id,uid,folder,message_id) VALUES ($1,$2,'INBOX',$3)
      ON CONFLICT(account_id,uid,folder) DO UPDATE SET uid=EXCLUDED.uid RETURNING id,(xmax=0) AS is_new`;
    let unblock, started;
    const held = new Promise(resolve => { unblock = resolve; });
    const reached = new Promise(resolve => { started = resolve; });
    let delayed = false, inserts = 0;
    h.delayedQuery = async (sql, params) => {
      if (sql.includes('INSERT INTO messages')) inserts++;
      if (!delayed && !sql.startsWith('WITH') && sql.includes('INSERT INTO messages')) {
        delayed = true; started(); await held;
      }
      return h.pool.query(sql, params);
    };
    const persist = () => persistWebhookMessage({ validity: 77, next: 10 }, account, 'INBOX',
      { uid: 11, messageId: '<same-uid@example.test>' }, insert, [account.id, 11, '<same-uid@example.test>']);
    const first = persist(); await reached;
    const second = persist();
    // Both callers have a chance to enter SQL. Correct serialization permits only
    // the held writer; this assertion does not depend on PostgreSQL/network speed.
    await Promise.resolve(); await Promise.resolve();
    const competingWrites = inserts;
    unblock(); await Promise.all([first, second]); h.delayedQuery = null;
    expect(competingWrites).toBe(1);
    expect((await counts()).events).toBe(0);
  });

  it('an independent empty INBOX backfill SELECT establishes the boundary for the next live arrival', async () => {
    const client = Object.assign(new EventEmitter(), {
      mailbox: { exists: 0, uidNext: 1, uidValidity: 77 }, usable: true,
      connect: async () => {}, close() {}, getMailboxLock: async () => ({ release() {} }),
    });
    ImapFlow.mockImplementation(function () { return client; });
    Object.assign(manager, { backfillRunning: new Set(), _secondaryConnectBlocked: () => false });
    await ImapManager.prototype.backfillMessages.call(manager, account, 'INBOX');
    await sync([1], { next: 2 });
    expect((await counts()).events).toBe(1);
  });

  it('does not duplicate events after repeated sync or cache rebuild in the same epoch', async () => {
    await sync([], { next: 1 }); await sync([3, 2], { next: 4 });
    const original = (await h.pool.query('SELECT id FROM webhook_events ORDER BY id')).rows;
    await sync([3, 2], { next: 4 });
    await h.pool.query('DELETE FROM messages');
    await sync([2, 3], { next: 4 });
    expect((await h.pool.query('SELECT id FROM webhook_events ORDER BY id')).rows).toEqual(original);
    expect((await counts()).deliveries).toBe(2);
  });

  it('rolls back mail+outbox together and sends nothing before commit or after rollback', async () => {
    await sync([], { next: 1 });
    const db = await h.pool.connect();
    await db.query('BEGIN'); h.bound = db;
    await sync([1], { next: 2 });
    h.bound = null;
    const send = vi.fn(async () => ({ statusCode: 204 }));
    expect(await createWebhookWorker({ pool: h.pool, send }).runOnce()).toBe(false);
    await db.query('ROLLBACK'); db.release();
    expect(await counts()).toEqual({ events: 0, deliveries: 0 });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('restore normalization keeps ordinary claims pending and exhausted claims failed and manually retryable', async () => {
    await sync([], { next: 1 }); await sync([1, 2], { next: 3 });
    const rows = (await h.pool.query('SELECT id FROM webhook_deliveries ORDER BY id')).rows;
    await h.pool.query(`UPDATE webhook_deliveries SET status='processing', attempts=CASE WHEN id=$1 THEN 1 ELSE 8 END,
      lease_token=gen_random_uuid(), lease_until=NOW()+interval '1 minute'`, [rows[0].id]);
    const db = await h.pool.connect();
    try { await db.query('BEGIN'); await pauseRestoredWebhooks(db); await db.query('COMMIT'); }
    finally { db.release(); }
    const restored = (await h.pool.query('SELECT status,attempts,lease_token,lease_until FROM webhook_deliveries ORDER BY id')).rows;
    expect(restored).toEqual([
      { status: 'pending', attempts: 1, lease_token: null, lease_until: null },
      { status: 'failed', attempts: 8, lease_token: null, lease_until: null },
    ]);
    expect((await h.pool.query('SELECT enabled FROM webhook_subscriptions')).rows[0].enabled).toBe(false);
    const service = createWebhookService({ pool: h.pool });
    await service.retry(account.user_id, subscription.id, rows[1].id);
    expect((await h.pool.query('SELECT status,attempts FROM webhook_deliveries WHERE id=$1', [rows[1].id])).rows[0])
      .toEqual({ status: 'pending', attempts: 0 });
  });

  it('an outbox constraint failure cannot leave a mail row committed without its event', async () => {
    await sync([], { next: 1 });
    await h.pool.query("ALTER TABLE webhook_deliveries ADD CONSTRAINT fixture_reject CHECK (status = 'failed')");
    try {
      await sync([1], { next: 2 });
      expect(await counts()).toEqual({ events: 0, deliveries: 0 });
      expect((await h.pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(0);
    } finally { await h.pool.query('ALTER TABLE webhook_deliveries DROP CONSTRAINT fixture_reject'); }
  });

  it('committed arrivals survive a real process restart; receiver commit before sender crash deduplicates recovery', async () => {
    await sync([], { next: 1 }); await sync([1], { next: 2 });
    await expect(subprocess({ MAILFLOW_TEST_CRASH_AFTER_ACK: '1' })).rejects.toMatchObject({ code: 17 });
    expect((await h.pool.query('SELECT status FROM webhook_deliveries')).rows[0].status).toBe('processing');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM webhook_receiver_jobs')).rows[0].n).toBe(1);
    await h.pool.query("UPDATE webhook_deliveries SET lease_until = NOW() - interval '1 second'");
    await subprocess();
    const delivered = (await h.pool.query('SELECT status,attempts FROM webhook_deliveries')).rows[0];
    expect(delivered).toEqual({ status: 'delivered', attempts: 2 });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM webhook_receiver_jobs')).rows[0].n).toBe(1);
    const row = (await h.pool.query('SELECT * FROM webhook_events')).rows[0];
    expect(Object.keys(row).sort()).toEqual(['account_id','id','message_id','occurred_at','uid','uid_validity','user_id'].sort());
    expect(subscription.target_url).toMatch(/^enc:v1:/);
  });
});
