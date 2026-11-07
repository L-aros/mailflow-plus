// Isolated release drill only. Copied into /app of the image under test, never
// imported by the application. All addresses/data are local synthetic fixtures.
import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { pool } from './src/services/db.js';
import { encrypt, decrypt, isEncrypted } from './src/services/encryption.js';
import { generateToken, hashToken } from './src/services/apiTokens.js';
import { ImapFlow } from 'imapflow';

const mode = process.argv[2];
const privateDir = '/drill';
const stateFile = `${privateDir}/state.json`;
const base = 'http://frontend';
const username = 'release-drill';
const password = 'Synthetic-only-restore-drill-2026';
const mailPassword = 'synthetic-mail-credential';
const baselineMessage = '10000000-0000-4000-8000-000000000001';
const upgradedMessage = '10000000-0000-4000-8000-000000000002';
const laterMessage = '10000000-0000-4000-8000-000000000003';
let state = {};
try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* first seed */ }
const save = () => writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
const result = { operation: mode, startedAt: new Date().toISOString(), checks: [] };
const checked = name => result.checks.push(name);

async function call(path, { method = 'GET', body, token, cookie, binary = false, gzip = false } = {}) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(60_000), headers: {
    ...(body !== undefined ? { 'Content-Type': gzip ? 'application/gzip' : 'application/json' } : {}),
    ...(method !== 'GET' ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  }, ...(body !== undefined ? { body: gzip ? body : JSON.stringify(body) } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  let data;
  if (!binary) { try { data = JSON.parse(bytes.toString()); } catch { data = bytes.toString(); } }
  return { status: response.status, data, bytes, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function login() {
  const response = await call('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200);
  assert.equal(response.data.user?.id, state.userId);
  assert.equal(response.data.user?.isAdmin, true);
  assert.ok(response.cookie);
  const me = await call('/api/auth/me', { cookie: response.cookie });
  assert.equal(me.status, 200);
  checked('real-http-login-and-redis-session');
  return response.cookie;
}

async function token() {
  const value = generateToken();
  await pool.query(`INSERT INTO api_tokens (user_id,name,token_hash,scopes,expires_at,confirmed_with)
    VALUES ($1,'release drill',$2,'["read"]',NOW()+interval '1 day','password')`, [state.userId, hashToken(value)]);
  return value;
}

async function addMessage(id, uid, subject) {
  // Seed an explicit parsed-mail cache fixture. Mail ingress/parser behavior is
  // covered by the existing sync tests; this drill verifies preservation.
  await pool.query(`INSERT INTO messages (id,account_id,uid,folder,message_id,subject,from_name,from_email,date,snippet,body_text,thread_id)
    VALUES ($1,$2,$3,'INBOX',$4,$5,'Virtual Sender','sender@example.test',$6,$7,$7,$8)`,
  [id, state.accountId, uid, `<release-${uid}@example.test>`, subject, '2026-11-07T00:00:00Z', `Synthetic restore body ${uid}.`, `<release-${uid}@example.test>`]);
}

// Prove restored ciphertext authenticates a REAL imapflow connection to a local
// virtual IMAP peer. The app account uses protocol=fixture to prevent automatic
// background mail sync from replacing these intentionally seeded cache rows.
async function credentialProbe() {
  const { rows: [account] } = await pool.query('SELECT auth_pass FROM email_accounts WHERE id=$1', [state.accountId]);
  assert.ok(isEncrypted(account.auth_pass));
  const restored = decrypt(account.auth_pass);
  assert.equal(restored, mailPassword);
  let authenticated = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] Virtual release IMAP\r\n');
    let buffer = '';
    let continuation;
    const auth = (encoded, tag) => {
      const parts = Buffer.from(encoded, 'base64').toString().split('\0');
      if (parts.at(-2) === 'drill@example.test' && parts.at(-1) === mailPassword) {
        authenticated++;
        socket.write(`${tag} OK Authenticated\r\n`);
      } else socket.write(`${tag} NO Authentication failed\r\n`);
    };
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        if (continuation) { const tag = continuation; continuation = null; auth(line, tag); continue; }
        const [tag, command, ...args] = line.split(' ');
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n${tag} OK Capability\r\n`);
        else if (command === 'AUTHENTICATE') {
          if (args[1]) auth(args[1], tag); else { continuation = tag; socket.write('+ \r\n'); }
        } else if (command === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK List\r\n`);
        else if (command === 'LOGOUT') { socket.write(`* BYE\r\n${tag} OK Logout\r\n`); socket.end(); }
        else socket.write(`${tag} OK Fixture command\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ImapFlow({ host: '127.0.0.1', port: server.address().port, secure: false, doSTARTTLS: false,
    auth: { user: 'drill@example.test', pass: restored }, logger: false, greetingTimeout: 3000, socketTimeout: 3000 });
  client.on('error', () => {});
  try { await client.connect(); await client.logout(); assert.equal(authenticated, 1); }
  finally { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  checked('restored-encrypted-mail-credential-real-imapflow-authentication');
}

async function apiProbe(expectedMessages, { missing = false } = {}) {
  const accounts = await call('/api/v1/accounts', { token: state.token });
  assert.equal(accounts.status, 200);
  assert.equal(accounts.data.data[0]?.id, state.accountId);
  const messages = await call('/api/v1/messages', { token: state.token });
  assert.equal(messages.status, 200);
  assert.equal(messages.data.data.length, expectedMessages);
  const body = await call(`/api/v1/messages/${baselineMessage}`, { token: state.token });
  assert.equal(body.status, missing ? 404 : 200);
  if (!missing) assert.equal(body.data.data.body.text, 'Synthetic restore body 1.');
  const search = await call('/api/v1/search?q=Baseline', { token: state.token });
  assert.equal(search.status, 200);
  assert.equal(search.data.data.length, missing ? 0 : 1);
  checked(missing ? 'api-accounts-and-cache-resource-404-after-setup' : 'api-accounts-message-list-body-search');
}

async function checkQueue(cookie) {
  assert.ok(state.expectedQueue, 'The pre-backup queue identity fixture must exist');
  const rows = (await pool.query('SELECT * FROM webhook_subscriptions')).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].enabled, false);
  assert.deepEqual(rows.map(({ id, user_id, account_id, name }) => ({ id, user_id, account_id, name })),
    [state.expectedQueue.subscription]);
  assert.equal(decrypt(rows[0].target_url), 'http://127.0.0.1:19876/virtual-receiver');
  assert.equal(decrypt(rows[0].signing_secret), state.webhookSecret);
  const deliveries = (await pool.query(`SELECT id,event_id,subscription_id,status,attempts,next_attempt_at::text,
    lease_token,lease_until::text,last_error,last_status,delivered_at::text,created_at::text
    FROM webhook_deliveries ORDER BY id`)).rows;
  assert.deepEqual(deliveries, state.expectedQueue.deliveries);
  const events = (await pool.query(`SELECT id,user_id,account_id,message_id,uid_validity::text,uid::text,occurred_at::text
    FROM webhook_events ORDER BY id`)).rows;
  assert.deepEqual(events, state.expectedQueue.events);
  const mailboxes = (await pool.query(`SELECT account_id,uid_validity::text,uid_next::text
    FROM webhook_mailboxes ORDER BY account_id`)).rows;
  assert.deepEqual(mailboxes, [state.expectedQueue.mailbox]);
  const list = await call('/api/webhooks', { cookie });
  assert.equal(list.status, 200); assert.equal(list.data.subscriptions[0].enabled, false);
  assert.equal(list.data.subscriptions[0].pending, 2); assert.equal(list.data.subscriptions[0].failed, 2);
  checked('webhook-four-table-identities-relations-event-timestamps-mailbox-baseline-preserved-paused-claims-normalized');
  checked('webhook-restored-credentials-decrypt-and-browser-management-api');
  result.queue = { subscriptions: 1, enabled: 0, events: 4, mailboxBaselines: 1, pending: 2, failed: 2, leases: 0,
    identityAndRelationsVerified: true, eventOccurredAtPreserved: true, mailboxBaselineValuesPreserved: true };
}

try {
  await mkdir(privateDir, { recursive: true });
  if (mode === 'seed') {
    const registration = await call('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(registration.status, 200); assert.equal(registration.data.user.isAdmin, true);
    state.userId = registration.data.user.id; state.accountId = randomUUID();
    await pool.query(`INSERT INTO email_accounts (id,user_id,name,email_address,protocol,auth_user,auth_pass,enabled)
      VALUES ($1,$2,'Virtual release mailbox','drill@example.test','fixture','drill@example.test',$3,true)`, [state.accountId, state.userId, encrypt(mailPassword)]);
    await pool.query(`INSERT INTO folders (account_id,path,name,uid_validity) VALUES ($1,'INBOX','Inbox',1)`, [state.accountId]);
    await pool.query("UPDATE system_settings SET value='true' WHERE key='api_tokens_enabled'");
    await pool.query("UPDATE users SET display_name='Release restoration fixture' WHERE id=$1", [state.userId]);
    await addMessage(baselineMessage, 1, 'Baseline synthetic message');
    state.token = await token(); state.oldToken = state.token; await save();
    await writeFile('/var/cache/mailflow/images/release-drill.txt', 'synthetic persistent cache fixture\n');
    checked('initial-admin-http-registration-closed-registration-synthetic-mail-cache-fixture');
  } else if (mode === 'upgrade-data') {
    await addMessage(upgradedMessage, 2, 'Upgrade synthetic message');
    state.webhookSecret = `mwhsec_${createHash('sha256').update('synthetic-only-receiver-secret').digest('base64url')}`;
    const subscription = randomUUID();
    state.expectedQueue = {
      subscription: { id: subscription, user_id: state.userId, account_id: state.accountId, name: 'Virtual restore receiver' },
      mailbox: { account_id: state.accountId, uid_validity: '1', uid_next: '2' },
      events: [], deliveries: [],
    };
    await pool.query(`INSERT INTO webhook_subscriptions (id,user_id,account_id,name,target_url,signing_secret)
      VALUES ($1,$2,$3,'Virtual restore receiver',$4,$5)`,
    [subscription, state.userId, state.accountId, encrypt('http://127.0.0.1:19876/virtual-receiver'), encrypt(state.webhookSecret)]);
    await pool.query('INSERT INTO webhook_mailboxes (account_id,uid_validity,uid_next) VALUES ($1,1,2)', [state.accountId]);
    for (const [i, status, attempts] of [[0, 'pending', 0], [1, 'processing', 2], [2, 'processing', 8], [3, 'failed', 8]]) {
      const event = randomUUID();
      const insertedEvent = await pool.query(`INSERT INTO webhook_events (id,user_id,account_id,message_id,uid_validity,uid)
        VALUES ($1,$2,$3,$4,1,$5) RETURNING occurred_at::text`, [event, state.userId, state.accountId, upgradedMessage, 2 + i]);
      state.expectedQueue.events.push({ id: event, user_id: state.userId, account_id: state.accountId,
        message_id: upgradedMessage, uid_validity: '1', uid: String(2 + i), occurred_at: insertedEvent.rows[0].occurred_at });
      const delivery = randomUUID();
      const insertedDelivery = await pool.query(`INSERT INTO webhook_deliveries (id,event_id,subscription_id,status,attempts,next_attempt_at,lease_token,lease_until)
        VALUES ($1,$2,$3,$4,$5,'2099-01-01',$6,$7) RETURNING next_attempt_at::text,created_at::text`,
      [delivery, event, subscription, status, attempts, status === 'processing' ? randomUUID() : null, status === 'processing' ? '2099-01-01' : null]);
      state.expectedQueue.deliveries.push({ id: delivery, event_id: event, subscription_id: subscription,
        status: status === 'processing' ? attempts >= 8 ? 'failed' : 'pending' : status, attempts,
        next_attempt_at: insertedDelivery.rows[0].next_attempt_at, lease_token: null, lease_until: null,
        last_error: status === 'processing' && attempts >= 8 ? 'lease_expired' : null,
        last_status: null, delivered_at: null, created_at: insertedDelivery.rows[0].created_at });
    }
    for (const table of ['events', 'deliveries']) {
      state.expectedQueue[table].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }
    await save(); checked('candidate-post-old-snapshot-message-webhook-durable-state');
  } else if (mode === 'mutate') {
    await addMessage(laterMessage, 3, 'After candidate snapshot message');
    await writeFile('/var/cache/mailflow/images/release-drill.txt', 'changed after snapshot\n');
    await writeFile('/var/cache/mailflow/images/after-snapshot.txt', 'must disappear after restoring the earlier snapshot\n');
    checked('post-snapshot-database-and-persistent-file-change');
  } else if (mode === 'pause-raw') {
    const { pauseRestoredWebhooks } = await import('./src/services/backup.js');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await pauseRestoredWebhooks(client); await client.query('COMMIT'); }
    finally { client.release(); }
    checked('operator-explicit-raw-restore-webhook-normalization-before-app-start');
  } else if (mode === 'download') {
    const cookie = await login();
    for (const scope of ['full', 'setup']) {
      const backup = await call(`/api/admin/backup?scope=${scope}`, { cookie, binary: true });
      assert.equal(backup.status, 200); assert.ok(backup.bytes.length > 100);
      await writeFile(`${privateDir}/candidate-${scope}.json.gz`, backup.bytes, { mode: 0o600 });
      result[`${scope}Sha256`] = createHash('sha256').update(backup.bytes).digest('hex');
    }
    checked('builtin-full-and-setup-real-http-backup-download');
  } else if (mode.startsWith('restore-')) {
    const scope = mode.slice('restore-'.length);
    assert.ok(['full', 'setup'].includes(scope));
    const cookie = await login();
    const restored = await call('/api/admin/backup/restore', { method: 'POST', cookie,
      body: await readFile(`${privateDir}/candidate-${scope}.json.gz`), gzip: true });
    assert.equal(restored.status, 200);
    const lines = restored.bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.ok(lines.some(line => line.ok === true && line.scope === scope));
    assert.ok(lines.every(line => !line.error)); checked(`builtin-${scope}-real-http-restore-committed`);
  } else if (mode === 'probe-worker') {
    // Invoked in a one-shot candidate image while the application's own worker
    // is stopped. Only this test process injects a send function for loopback.
    const { createWebhookWorker } = await import('./src/services/webhooks.js');
    const { sendWebhook } = await import('./src/services/webhookTransport.js');
    let received = 0;
    const receiver = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks); const timestamp = req.headers['x-mailflow-timestamp'];
      const expected = 'v1=' + createHmac('sha256', state.webhookSecret).update(timestamp + '.').update(bytes).digest('hex');
      const actual = req.headers['x-mailflow-signature'] || '';
      assert.equal(actual.length, expected.length); assert.ok(timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
      assert.equal(JSON.parse(bytes).type, 'message.received');
      received++; res.writeHead(204); res.end();
    });
    await new Promise(resolve => receiver.listen(19876, '127.0.0.1', resolve));
    try {
      await assert.rejects(sendWebhook({ url: 'http://127.0.0.1:19876/virtual-receiver', secret: state.webhookSecret, eventId: randomUUID(), body: '{}', timestamp: String(Math.floor(Date.now() / 1000)), timeoutMs: 1000 }));
      assert.equal(received, 0); checked('production-transport-rejects-private-target-zero-requests');
      await pool.query("UPDATE webhook_deliveries SET next_attempt_at=NOW() WHERE status='pending' AND attempts=0");
      const worker = createWebhookWorker({ pool, send: async ({ url, secret, eventId, body, timestamp }) => {
        const signature = createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
        const reply = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(2000), headers: {
          'x-mailflow-signature': 'v1=' + signature, 'x-mailflow-timestamp': timestamp, 'x-mailflow-event-id': eventId,
        } });
        return { statusCode: reply.status };
      } });
      try { assert.equal(await worker.runOnce(), true); } finally { await worker.stop(); }
      assert.equal(received, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_deliveries WHERE status='delivered' AND last_status=204")).rows[0].count, 1);
      result.receiver = { productionRequests: 0, injectedTransportRequests: 1, verifiedHmac: true };
      checked('real-image-worker-injected-loopback-http-204-signature-verified');
    } finally { receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); }
  } else if (mode.startsWith('verify-')) {
    const kind = mode.slice('verify-'.length);
    const health = await call('/api/health'); assert.equal(health.status, 200); assert.equal(health.data.status, 'ok');
    const page = await call('/', { binary: true }); assert.equal(page.status, 200); assert.match(page.bytes.toString(), /<html/i);
    const version = await call('/api/version'); assert.equal(version.status, 200); result.runtimeVersion = version.data;
    assert.match(version.data.sha, /^[a-f0-9]{40}$/);
    assert.equal(version.data.sha, process.env.BUILD_SHA);
    if (!['old', 'rollback'].includes(kind)) {
      const frontendBuild = await call('/build-info.json');
      assert.equal(frontendBuild.status, 200);
      assert.equal(frontendBuild.data.sha, version.data.sha);
      assert.equal(frontendBuild.data.version, version.data.version);
      const sourceUrl = `https://github.com/L-aros/mailflow-plus/tree/${version.data.sha}`;
      assert.equal(frontendBuild.data.sourceUrl, sourceUrl);
      assert.equal(version.data.sourceUrl, sourceUrl);
      result.frontendBuild = frontendBuild.data;
      checked('frontend-backend-same-baked-source-sha-version-fixed-fork-source-url');
    }
    result.schema = (await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')).rows[0].version;
    assert.equal(result.schema, ['old', 'rollback'].includes(kind) ? '0075_gmail_provider_msgid' : '0076_webhooks');
    const cookie = await login();
    assert.equal((await pool.query('SELECT display_name FROM users WHERE id=$1', [state.userId])).rows[0].display_name, 'Release restoration fixture');
    assert.equal((await pool.query("SELECT value FROM system_settings WHERE key='registration_open'")).rows[0].value, 'false');
    await credentialProbe();
    const builtin = ['full', 'setup'].includes(kind);
    const previous = await call('/api/v1/accounts', { token: state.oldToken });
    assert.equal(previous.status, builtin ? 401 : 200);
    if (builtin) { assert.equal((await pool.query('SELECT count(*)::int AS count FROM api_tokens')).rows[0].count, 0); state.token = await token(); await save(); }
    else state.token = state.oldToken;
    checked(builtin ? 'builtin-restore-invalidates-old-token-and-new-token-works' : 'raw-or-upgrade-preserves-snapshot-token');
    await apiProbe(kind === 'setup' ? 0 : ['old', 'rollback', 'upgrade'].includes(kind) ? 1 : 2, { missing: kind === 'setup' });
    if (['raw', 'full', 'setup'].includes(kind)) await checkQueue(cookie);
    if (kind === 'rollback') {
      assert.equal((await pool.query("SELECT to_regclass('public.webhook_events') AS table_name")).rows[0].table_name, null);
      assert.equal((await pool.query('SELECT id FROM messages WHERE id=ANY($1::uuid[])', [[upgradedMessage, laterMessage]])).rows.length, 0);
      checked('matched-pre0076-image-schema-and-old-recovery-point-no-newer-messages');
    }
    if (kind === 'raw') {
      assert.equal((await pool.query('SELECT id FROM messages WHERE id=$1', [laterMessage])).rows.length, 0);
      await assert.rejects(access('/var/cache/mailflow/images/after-snapshot.txt'), { code: 'ENOENT' });
      checked('post-candidate-snapshot-message-absent-after-raw-restore');
      checked('post-candidate-snapshot-extra-persistent-file-removed');
    }
    if (['old', 'raw', 'rollback'].includes(kind)) {
      assert.equal(await readFile('/var/cache/mailflow/images/release-drill.txt', 'utf8'), 'synthetic persistent cache fixture\n');
      checked('persistent-image-cache-file-restored');
    }
    checked('frontend-and-api-health-real-nginx-app-container');
  } else throw new Error(`Unknown drill fixture operation: ${mode}`);
  result.finishedAt = new Date().toISOString();
  result.elapsedMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  result.ok = true;
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { await pool.end(); }
