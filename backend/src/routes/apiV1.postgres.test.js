import 'express-async-errors';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import express from 'express';
import session from 'express-session';

const state = vi.hoisted(() => ({ database: null, counters: new Map() }));
vi.mock('../services/db.js', () => ({
  query: (sql, params) => state.database.query(sql, params),
  withTransaction: async fn => fn(state.database),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {
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
vi.mock('../services/authEvents.js', () => ({ logAuthEvent: vi.fn() }));
vi.mock('../services/lastSeen.js', () => ({ touchLastSeen: vi.fn() }));
// apiTokenGuards imports the internal mail router. Never load the application entry point.
vi.mock('../index.js', () => ({ imapManager: {} }));

import { mountApiAuth } from '../middleware/apiChain.js';
import { apiV1ErrorHandler } from '../middleware/apiV1.js';
import { requireAuth } from '../middleware/auth.js';
import { buildSessionOptions } from '../utils/sessionConfig.js';
import {
  generateToken, hashToken, invalidateApiTokenSettingsCache, resetTokenUseForTests,
} from '../services/apiTokens.js';
import apiV1Routes from './apiV1.js';
import searchRoutes from './search.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ACCOUNT = '10000000-0000-4000-8000-000000000001';
const OPTED_OUT = '10000000-0000-4000-8000-000000000002';
const FOREIGN = '10000000-0000-4000-8000-000000000003';
const DISABLED = '10000000-0000-4000-8000-000000000004';
const messageId = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Real SQL and real HTTP/authentication, with connection-local temporary tables only. The
// account hosts are fixtures and the mail engine is a stub: no mailbox connection or send.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('versioned read API PostgreSQL and HTTP', () => {
  let server, base, readToken, otherToken, organizeToken, draftToken;
  const imap = { fetchMessageBody: vi.fn() };

  beforeAll(async () => {
    state.database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await state.database.connect();
    await state.database.query(`
      CREATE TEMP TABLE users (id uuid PRIMARY KEY, username text NOT NULL);
      CREATE TEMP TABLE oidc_providers (id uuid PRIMARY KEY);
      CREATE TEMP TABLE system_settings (key varchar(100) PRIMARY KEY, value text);
      CREATE TEMP TABLE email_accounts (id uuid PRIMARY KEY, user_id uuid, enabled boolean,
        include_in_unified_inbox boolean, name text, email_address text, color text,
        sort_order integer DEFAULT 0, created_at timestamptz DEFAULT NOW(), protocol text DEFAULT 'imap',
        imap_host text DEFAULT 'mail.example.test', auth_pass text DEFAULT 'fixture-secret', folder_mappings jsonb DEFAULT '{}');
      CREATE TEMP TABLE folders (account_id uuid, path text, name text, special_use text,
        no_select boolean DEFAULT false, total_count integer DEFAULT 99, unread_count integer DEFAULT 99);
      CREATE TEMP TABLE contacts (id uuid, user_id uuid, primary_email text, photo_data text);
      CREATE TEMP TABLE messages (id uuid PRIMARY KEY, account_id uuid, uid bigint DEFAULT 1,
        folder text DEFAULT 'INBOX', message_id text, subject text DEFAULT 'Orion report',
        from_name text DEFAULT 'Sender', from_email text DEFAULT 'sender@example.test',
        to_addresses jsonb DEFAULT '[{"name":"Recipient","address":"reader@example.test"}]',
        cc_addresses jsonb DEFAULT '[]', reply_to jsonb DEFAULT '[]', bcc_addresses jsonb DEFAULT '[]',
        in_reply_to text, thread_references text, thread_id text, date timestamptz DEFAULT '2026-01-01T00:00:00Z',
        snippet text DEFAULT 'Fixture snippet', is_read boolean DEFAULT false, is_starred boolean DEFAULT false,
        has_attachments boolean DEFAULT false, category text, list_unsubscribe text, list_unsubscribe_post text,
        delivery_addresses jsonb, spam_verdict text, spam_user_override text, spam_score_ml real,
        is_deleted boolean DEFAULT false, body_html text DEFAULT '<p>Orion fixture</p>',
        body_text text DEFAULT 'Orion fixture', attachments jsonb DEFAULT '[]', flags text[] DEFAULT '{}',
        search_vector tsvector);
    `);
    // Use the shipping token migration, including its disabled-by-default switch and hash index.
    const migration = readFileSync(new URL('../../migrations/0074_api_tokens.sql', import.meta.url), 'utf8');
    await state.database.query(migration.replace('CREATE TABLE IF NOT EXISTS api_tokens', 'CREATE TEMP TABLE api_tokens'));
    const app = express();
    app.set('imapManager', imap);
    mountApiAuth(app, session(buildSessionOptions(new session.MemoryStore(), 'fixture-session-secret'.padEnd(40, 'x'))));
    app.get('/fixture-login/:userId', (req, res) => {
      req.session.userId = req.params.userId;
      req.session.locked = req.query.locked === '1';
      res.json({ ok: true });
    });
    app.use('/api/v1', apiV1Routes);
    app.use('/api/v1', apiV1ErrorHandler);
    app.use('/api/search', searchRoutes);
    // Existing organize/draft paths remain governed by the unchanged allowlist/auth chain.
    app.post('/api/mail/messages/bulk-read', requireAuth, (_req, res) => res.json({ allowed: true }));
    app.post('/api/mail/reply-drafts/indicators', requireAuth, (_req, res) => res.json({ allowed: true }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await state.database?.end();
  });

  const token = async (userId, scopes, expired = false) => {
    const secret = generateToken();
    const { rows: [row] } = await state.database.query(`INSERT INTO api_tokens
      (user_id, name, token_hash, scopes, expires_at, confirmed_with)
      VALUES ($1, 'fixture tool', $2, $3, NOW() + $4::interval, 'password') RETURNING id`,
    [userId, hashToken(secret), JSON.stringify(scopes), expired ? '-1 minute' : '1 day']);
    return { secret, id: row.id };
  };
  const call = async (path, { credential = readToken, method = 'GET', headers = {}, body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(credential ? { Authorization: `Bearer ${credential.secret}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const insertMessage = (n, account = ACCOUNT, overrides = {}) => {
    const values = { id: messageId(n), account_id: account, message_id: `<fixture-${n}@example.test>`, ...overrides };
    const columns = Object.keys(values);
    return state.database.query(`INSERT INTO messages (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(values));
  };
  const expectError = (result, status, code) => {
    expect(result.status).toBe(status);
    expect(result.json).toEqual({ error: { code, message: expect.any(String) } });
  };

  beforeEach(async () => {
    state.counters.clear();
    resetTokenUseForTests();
    imap.fetchMessageBody.mockReset();
    await state.database.query(`
      TRUNCATE api_tokens, users, email_accounts, folders, messages, contacts;
      UPDATE system_settings SET value = 'true' WHERE key = 'api_tokens_enabled';
      INSERT INTO users VALUES ('${OWNER}', 'fixture-owner'), ('${OTHER}', 'fixture-other');
      INSERT INTO email_accounts (id, user_id, enabled, include_in_unified_inbox, name, email_address, sort_order) VALUES
        ('${ACCOUNT}', '${OWNER}', true, true, 'Primary', 'owner@example.test', 1),
        ('${OPTED_OUT}', '${OWNER}', true, false, 'Secondary', 'secondary@example.test', 2),
        ('${FOREIGN}', '${OTHER}', true, true, 'Foreign', 'other@example.test', 3),
        ('${DISABLED}', '${OWNER}', false, true, 'Disabled', 'disabled@example.test', 4);
      INSERT INTO folders (account_id,path,name,special_use) VALUES
        ('${ACCOUNT}','INBOX','Inbox','\\Inbox'), ('${ACCOUNT}','Archive','Archive','\\Archive'),
        ('${ACCOUNT}','Trash','Trash','\\Trash'), ('${FOREIGN}','Private','Private',NULL),
        ('${OPTED_OUT}','INBOX','Inbox','\\Inbox');
    `);
    invalidateApiTokenSettingsCache();
    readToken = await token(OWNER, ['read']);
    otherToken = await token(OTHER, ['read']);
    organizeToken = await token(OWNER, ['organize']);
    draftToken = await token(OWNER, ['draft']);
    await insertMessage(1);
    await insertMessage(2);
    await insertMessage(3);
    await insertMessage(4, ACCOUNT, { folder: 'Archive' });
    await insertMessage(5, OPTED_OUT);
    await insertMessage(6, FOREIGN);
    await insertMessage(7, DISABLED);
    await insertMessage(8, ACCOUNT, { is_deleted: true });
    await insertMessage(9, ACCOUNT, { folder: 'Trash' });
  });

  it('pages projected account/folder metadata without credentials or other users', async () => {
    const first = await call('/api/v1/accounts?limit=1');
    expect(first.status).toBe(200);
    expect(first.json.data).toEqual([{ id: ACCOUNT, name: 'Primary', email: 'owner@example.test' }]);
    expect(first.json.pagination).toEqual({ limit: 1, offset: 0, hasMore: true, nextOffset: 1 });
    const second = await call('/api/v1/accounts?limit=1&offset=1');
    expect(second.json.data).toEqual([{ id: OPTED_OUT, name: 'Secondary', email: 'secondary@example.test' }]);
    expect(second.json.pagination).toEqual({ limit: 1, offset: 1, hasMore: false, nextOffset: null });
    const folders = await call(`/api/v1/accounts/${ACCOUNT}/folders?limit=2`);
    expect(folders.status).toBe(200);
    expect(folders.json.data.map(row => row.path)).toEqual(['Archive', 'INBOX']);
    expect(folders.json.data[0]).toEqual({ accountId: ACCOUNT, path: 'Archive', name: 'Archive', specialUse: '\\Archive' });
    expect(folders.json.pagination.hasMore).toBe(true);
    expect(JSON.stringify(first.json)).not.toMatch(/fixture-secret|imap_host|auth_pass|token_hash/);
    expect(first.headers.get('cache-control')).toContain('no-store');
  });

  it('pages actual flat messages with stable tie ordering and no cached folder total', async () => {
    const first = await call('/api/v1/messages?limit=2');
    const second = await call('/api/v1/messages?limit=2&offset=2');
    expect(first.status).toBe(200);
    expect(first.json.data.map(row => row.id)).toEqual([messageId(1), messageId(2)]);
    expect(first.json.pagination).toEqual({ limit: 2, offset: 0, hasMore: true, nextOffset: 2 });
    expect(second.json.data.map(row => row.id)).toEqual([messageId(3)]);
    expect(second.json.pagination).toEqual({ limit: 2, offset: 2, hasMore: false, nextOffset: null });
    expect(first.json).not.toHaveProperty('total');
    expect(first.json.data[0]).not.toHaveProperty('body');
    expect((await call('/api/v1/messages?offset=100')).json.data).toEqual([]);
    expect((await call(`/api/v1/messages?accountId=${OPTED_OUT}`)).json.data.map(row => row.id)).toEqual([messageId(5)]);
    expect((await call(`/api/v1/messages?accountId=${ACCOUNT}&folder=Archive`)).json.data.map(row => row.id)).toEqual([messageId(4)]);
    await state.database.query('UPDATE messages SET is_read = true WHERE id = $1', [messageId(1)]);
    expect((await call('/api/v1/messages?unreadOnly=true')).json.data.map(row => row.id)).toEqual([messageId(2), messageId(3)]);
  });

  it('keeps the lookahead row when using the maximum 200-message page', async () => {
    await state.database.query(`INSERT INTO messages (id, account_id, message_id)
      SELECT ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, $1, '<page-' || n || '@example.test>'
      FROM generate_series(10,210) n`, [ACCOUNT]);
    for (const path of ['/api/v1/messages', '/api/v1/search?q=Orion']) {
      const separator = path.includes('?') ? '&' : '?';
      const first = await call(`${path}${separator}limit=200`);
      const next = await call(`${path}${separator}limit=200&offset=200`);
      expect(first.status).toBe(200);
      expect(first.json.data).toHaveLength(200);
      expect(first.json.pagination).toEqual({ limit: 200, offset: 0, hasMore: true, nextOffset: 200 });
      expect(next.json.pagination.hasMore).toBe(false);
      const ids = [...first.json.data, ...next.json.data].map(row => row.id);
      expect(new Set(ids).size).toBe(path.includes('search') ? 205 : 204);
      expect(ids).toHaveLength(new Set(ids).size);
    }
  });

  it('continues pagination beyond offset 100000 without duplicates', async () => {
    await state.database.query(`INSERT INTO messages (id, account_id, message_id)
      SELECT md5('window-' || n)::uuid, $1, '<window-' || n || '@example.test>'
      FROM generate_series(1,100205) n`, [ACCOUNT]);
    const results = [];
    for (const offset of [100000, 100050, 100100]) {
      const result = await call(`/api/v1/messages?accountId=${ACCOUNT}&offset=${offset}&limit=50`);
      expect(result.status).toBe(200);
      expect(result.json.data).toHaveLength(50);
      expect(result.json.pagination).toEqual({ limit: 50, offset, hasMore: true, nextOffset: offset + 50 });
      results.push(...result.json.data);
    }
    expect(new Set(results.map(row => row.id)).size).toBe(150);
  });

  it('returns content and only attachment metadata without marking the message read', async () => {
    await state.database.query(`UPDATE messages SET has_attachments = true, attachments = $2,
      body_html = '<p>Fixture<script>bad()</script></p>' WHERE id = $1`, [messageId(1), JSON.stringify([
      { part: '2', filename: 'report.txt', type: 'text/plain', size: 12, content: 'attachment-secret', internal: 'hidden' },
    ])]);
    const result = await call(`/api/v1/messages/${messageId(1)}`);
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({
      id: messageId(1), accountId: ACCOUNT, messageId: '<fixture-1@example.test>', folder: 'INBOX',
      subject: 'Orion report', from: { name: 'Sender', email: 'sender@example.test' },
      to: [{ name: 'Recipient', email: 'reader@example.test' }], cc: [], replyTo: [],
      isRead: false, body: { text: 'Orion fixture', html: expect.any(String) },
      attachments: [{ part: '2', filename: 'report.txt', contentType: 'text/plain', size: 12 }],
    });
    expect(result.json.data.body.html).not.toContain('<script');
    expect(JSON.stringify(result.json)).not.toMatch(/attachment-secret|auth_pass|fixture-secret|preferences/);
    expect(imap.fetchMessageBody).not.toHaveBeenCalled();
    expect((await state.database.query('SELECT is_read FROM messages WHERE id = $1', [messageId(1)])).rows[0].is_read).toBe(false);
  });

  it('fetches an uncached body through the existing engine and stores sanitized content', async () => {
    await state.database.query('UPDATE messages SET body_html = NULL, body_text = NULL WHERE id = $1', [messageId(1)]);
    imap.fetchMessageBody.mockResolvedValue({ html: '<p>Fetched<script>bad()</script></p>', text: 'Fetched fixture', attachments: [] });
    const result = await call(`/api/v1/messages/${messageId(1)}`);
    expect(result.status).toBe(200);
    expect(result.json.data.body.text).toBe('Fetched fixture');
    expect(result.json.data.body.html).not.toContain('<script');
    expect(imap.fetchMessageBody).toHaveBeenCalledTimes(1);
    const cached = (await state.database.query('SELECT body_text, is_read FROM messages WHERE id = $1', [messageId(1)])).rows[0];
    expect(cached).toEqual({ body_text: 'Fetched fixture', is_read: false });
  });

  it('reads and caches a legitimate attachment-only message without repeated engine fetches', async () => {
    await state.database.query('UPDATE messages SET body_html = NULL, body_text = NULL, has_attachments = true WHERE id = $1', [messageId(1)]);
    imap.fetchMessageBody.mockResolvedValue({ html: null, text: null, attachments: [
      { part: '1', filename: 'attachment-only.txt', type: 'text/plain', size: 19 },
    ] });
    const expected = { body: { html: null, text: '' }, attachments: [
      { part: '1', filename: 'attachment-only.txt', contentType: 'text/plain', size: 19 },
    ] };
    const first = await call(`/api/v1/messages/${messageId(1)}`);
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject(expected);
    const second = await call(`/api/v1/messages/${messageId(1)}`);
    expect(second.status).toBe(200);
    expect(second.json.data).toMatchObject(expected);
    expect(imap.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect((await state.database.query('SELECT is_read FROM messages WHERE id = $1', [messageId(1)])).rows[0].is_read).toBe(false);
  });

  it('fetches content when only attachment metadata was cached by synchronization', async () => {
    await state.database.query('UPDATE messages SET body_html = NULL, body_text = NULL, attachments = $2 WHERE id = $1', [messageId(1), JSON.stringify([
      { part: '2', filename: 'metadata-only.txt', type: 'text/plain', size: 22 },
    ])]);
    imap.fetchMessageBody.mockResolvedValue({ html: '<p>Complete fetched body</p>', text: 'Complete fetched body', attachments: [
      { part: '2', filename: 'metadata-only.txt', type: 'text/plain', size: 22 },
    ] });
    const result = await call(`/api/v1/messages/${messageId(1)}`);
    expect(result.status).toBe(200);
    expect(result.json.data.body.text).toBe('Complete fetched body');
    expect(result.json.data.attachments).toEqual([
      { part: '2', filename: 'metadata-only.txt', contentType: 'text/plain', size: 22 },
    ]);
    expect(imap.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect((await state.database.query('SELECT body_text FROM messages WHERE id = $1', [messageId(1)])).rows[0].body_text).toBe('Complete fetched body');
  });

  it('does not cache a stale fetched body when the Message-ID changed during the fetch', async () => {
    await state.database.query('UPDATE messages SET body_html = NULL, body_text = NULL WHERE id = $1', [messageId(1)]);
    imap.fetchMessageBody.mockImplementation(async () => {
      // Simulate UID reuse/reconciliation without changing uid, folder or the empty body.
      await state.database.query('UPDATE messages SET message_id = $2 WHERE id = $1', [messageId(1), '<replacement@example.test>']);
      return { html: '<p>Stale body</p>', text: 'Stale body', attachments: [] };
    });
    expectError(await call(`/api/v1/messages/${messageId(1)}`), 503, 'body_unavailable');
    expect((await state.database.query('SELECT message_id, body_html, body_text FROM messages WHERE id = $1', [messageId(1)])).rows[0]).toEqual({
      message_id: '<replacement@example.test>', body_html: null, body_text: null,
    });
  });

  it('returns a fixed unavailable error when an uncached body cannot be retrieved', async () => {
    await state.database.query('UPDATE messages SET body_html = NULL, body_text = NULL WHERE id = $1', [messageId(1)]);
    imap.fetchMessageBody.mockRejectedValue(new Error('secret upstream mailbox host'));
    const result = await call(`/api/v1/messages/${messageId(1)}`);
    expectError(result, 503, 'body_unavailable');
    expect(JSON.stringify(result.json)).not.toContain('secret upstream mailbox host');
  });

  it('searches owned mail with stable pagination, filters and explicit all-folder semantics', async () => {
    const first = await call('/api/v1/search?q=Orion&limit=2');
    const second = await call('/api/v1/search?q=Orion&limit=2&offset=2');
    expect(first.status).toBe(200);
    expect(first.json.data.map(row => row.id)).toEqual([messageId(1), messageId(2)]);
    expect(first.json.pagination.hasMore).toBe(true);
    expect(second.json.data.map(row => row.id)).toEqual([messageId(3), messageId(4)]);
    expect(second.json.pagination.hasMore).toBe(false);
    expect((await call(`/api/v1/search?q=Orion&accountId=${OPTED_OUT}`)).json.data.map(row => row.id)).toEqual([messageId(5)]);
    // Preserve the browser's search semantics: even in:all excludes Trash; an explicit
    // Trash folder/operator opts into it.
    expect((await call('/api/v1/search?q=in%3Aall%20Orion')).json.data.map(row => row.id)).toEqual([1, 2, 3, 4].map(messageId));
    expect((await call('/api/v1/search?q=in%3Atrash%20Orion')).json.data.map(row => row.id)).toEqual([messageId(9)]);
    expect((await call('/api/v1/search?q=Orion&folder=Archive')).json.data.map(row => row.id)).toEqual([messageId(4)]);
    expect((await call('/api/v1/search?q=subject%3Amissing')).json.data).toEqual([]);
  });

  it('refuses foreign, disabled, deleted and nonexistent resources without scope fallback', async () => {
    for (const account of [FOREIGN, DISABLED, '10000000-0000-4000-8000-999999999999']) {
      expectError(await call(`/api/v1/accounts/${account}/folders`), 404, 'not_found');
      expectError(await call(`/api/v1/messages?accountId=${account}`), 404, 'not_found');
      expectError(await call(`/api/v1/search?q=Orion&accountId=${account}`), 404, 'not_found');
    }
    for (const n of [6, 7, 8, 99]) expectError(await call(`/api/v1/messages/${messageId(n)}`), 404, 'not_found');
    expectError(await call(`/api/v1/messages/${messageId(1)}`, { credential: otherToken }), 404, 'not_found');
    expect((await call('/api/v1/messages', { credential: otherToken })).json.data.map(row => row.id)).toEqual([messageId(6)]);
    expect(imap.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('rejects missing, malformed and unknown tokens and ignores a browser cookie', async () => {
    for (const credential of [null, { secret: 'mfat_bad' }, { secret: generateToken() }, { secret: 'unrelated-jwt' }]) {
      expectError(await call('/api/v1/accounts', { credential }), 401, 'unauthorized');
    }
    const signedIn = await call(`/fixture-login/${OWNER}`, { credential: null });
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];
    expectError(await call('/api/v1/accounts', { credential: null, headers: { Cookie: cookie } }), 401, 'unauthorized');
    const foreign = await call('/api/v1/messages', { credential: otherToken, headers: { Cookie: cookie } });
    expect(foreign.json.data.map(row => row.id)).toEqual([messageId(6)]);
  });

  it('requires a token before evaluating a locked cookie and keeps browser lock semantics', async () => {
    const signedIn = await call(`/fixture-login/${OWNER}?locked=1`, { credential: null });
    const cookie = signedIn.headers.get('set-cookie').split(';')[0];
    for (const credential of [null, { secret: 'unrelated-jwt' }]) {
      expectError(await call('/api/v1/messages', { credential, headers: { Cookie: cookie } }), 401, 'unauthorized');
    }
    const tokenRequest = await call('/api/v1/messages', { credential: otherToken, headers: { Cookie: cookie } });
    expect(tokenRequest.status).toBe(200);
    expect(tokenRequest.json.data.map(row => row.id)).toEqual([messageId(6)]);
    const browserRequest = await call('/api/search?q=Orion', { credential: null, headers: { Cookie: cookie } });
    expect(browserRequest.status).toBe(423);
    expect(browserRequest.json).toEqual({ error: 'Locked', locked: true });
  });

  it('enforces the admin switch, expiry and revocation on the versioned paths', async () => {
    await state.database.query("UPDATE system_settings SET value = 'false' WHERE key = 'api_tokens_enabled'");
    invalidateApiTokenSettingsCache();
    expectError(await call('/api/v1/accounts'), 401, 'unauthorized');
    await state.database.query("UPDATE system_settings SET value = 'true' WHERE key = 'api_tokens_enabled'");
    invalidateApiTokenSettingsCache();
    expectError(await call('/api/v1/accounts', { credential: await token(OWNER, ['read'], true) }), 401, 'unauthorized');
    expect((await call('/api/v1/accounts')).status).toBe(200);
    await state.database.query('DELETE FROM api_tokens WHERE id = $1', [readToken.id]);
    expectError(await call('/api/v1/accounts'), 401, 'unauthorized');
  });

  it('requires read scope and preserves existing organize/draft permissions', async () => {
    for (const credential of [organizeToken, draftToken]) expectError(await call('/api/v1/accounts', { credential }), 403, 'forbidden');
    expect((await call('/api/mail/messages/bulk-read', { credential: organizeToken, method: 'POST' })).status).toBe(200);
    expect((await call('/api/mail/reply-drafts/indicators', { credential: draftToken, method: 'POST' })).status).toBe(200);
    expect((await call('/api/mail/messages/bulk-read', { method: 'POST' })).status).toBe(403);
    expectError(await call('/api/v1/messages', { method: 'POST' }), 403, 'forbidden');
    expectError(await call(`/api/v1/messages/${messageId(1)}`, { method: 'DELETE' }), 403, 'forbidden');
    expectError(await call('/api/v1/accounts/'), 403, 'forbidden');
  });

  it('validates bounded pagination, scalar parameters, identifiers and supported filters', async () => {
    for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'offset=-1', 'offset=9007199254740992', 'offset=1x', 'limit=2&limit=3',
      'unknown=true', 'unreadOnly=yes', 'accountId=bad', 'folder=Archive', 'folder=', 'folder=%00']) {
      expectError(await call(`/api/v1/messages?${query}`), 400, 'invalid_request');
    }
    for (const query of ['', 'q=', 'q=x', `q=${'x'.repeat(501)}`, 'q=Orion&q=report', 'q=Orion&unknown=1']) {
      expectError(await call(`/api/v1/search?${query}`), 400, 'invalid_request');
    }
    expect((await call('/api/v1/messages?limit=200&offset=100000')).status).toBe(200);
    expect((await call('/api/v1/messages?offset=100001')).status).toBe(200);
    const lastSafeOffset = await call('/api/v1/messages?offset=9007199254740991');
    expect(lastSafeOffset.status).toBe(200);
    expect(lastSafeOffset.json).toEqual({ data: [], pagination: { limit: 50, offset: 9007199254740991, hasMore: false, nextOffset: null } });
    expect((await call('/api/v1/messages')).json.pagination).toEqual({ limit: 50, offset: 0, hasMore: false, nextOffset: null });
  });

  it('retains the shared per-token request budget and Retry-After response', async () => {
    state.counters.set(`rl:api-token:${readToken.id}`, { count: 600, expires: Date.now() + 60_000 });
    const result = await call('/api/v1/accounts');
    expectError(result, 429, 'rate_limited');
    expect(Number(result.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('shares one search budget across old and versioned paths for the same user', async () => {
    const searchUser = '00000000-0000-4000-8000-000000000003';
    await state.database.query("INSERT INTO users VALUES ($1, 'search-fixture')", [searchUser]);
    const credential = await token(searchUser, ['read']);
    for (let i = 0; i < 60; i++) {
      expect((await call(i % 2 ? '/api/search?q=Orion' : '/api/v1/search?q=Orion', { credential })).status).toBe(200);
    }
    expectError(await call('/api/v1/search?q=Orion', { credential }), 429, 'rate_limited');
    expect((await call('/api/search?q=Orion', { credential })).status).toBe(429);
  });
});
