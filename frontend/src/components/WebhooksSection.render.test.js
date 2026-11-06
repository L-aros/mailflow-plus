// Exercise the actual card and API client against a virtual HTTP receiver/configuration server.
// No email, real endpoint or browser storage participates in these operations.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) return { format: 'module', shortCircuit: true, source: `
      const en = ${JSON.stringify(en)};
      export const initReactI18next = { type: '3rdParty', init() {} };
      export const useTranslation = () => ({ i18n: { language: 'en' }, t: (key, opts = {}) => {
        let value = key.split('.').reduce((v, k) => v?.[k], en) ?? key;
        for (const [k, v] of Object.entries(opts)) value = value.replaceAll('{{' + k + '}}', String(v));
        return value;
      } });
    ` };
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.endsWith('.jsx')) return { format: 'module', shortCircuit: true, source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { DEV: false } });
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { default: WebhooksSection } = await import('./WebhooksSection.jsx');
const account = { id: 'account-1', name: 'Fixture mailbox', email_address: 'fixture@example.invalid', enabled: true };
const secret = 'fixture-new-signing-key-never-persisted';
const subscription = { id: 'sub-1', name: 'Fixture hook', accountId: account.id, targetOrigin: 'https://receiver.example.invalid', enabled: true, pending: 1, failed: 1 };
let root, subscriptions, deliveries, calls, listFailure, createResponse;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const host = document.getElementById('root');
const text = () => host.textContent;
const btn = label => [...host.querySelectorAll('button')].find(b => b.textContent === label);
const click = el => act(async () => { assert.ok(el); el.click(); });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function until(check) { for (let i = 0; i < 40; i++) { if (check()) return; await flush(); } assert.fail(text()); }
async function fill(el, value) {
  await act(async () => {
    const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function mount() {
  await act(async () => { root = createRoot(host); root.render(React.createElement(WebhooksSection)); });
  await flush();
}
async function createHook() {
  const inputs = host.querySelectorAll('input');
  await fill(inputs[0], 'New fixture');
  await fill(host.querySelector('select'), account.id);
  await fill(inputs[1], 'https://receiver.example.invalid/hook?key=target-secret');
  await click(btn(en.admin.webhooks.create));
}
beforeEach(() => {
  subscriptions = [{ ...subscription }];
  deliveries = [{ id: 'delivery-1', eventId: 'event-1', status: 'failed', attempts: 8, lastError: 'network_error', lastStatus: null }];
  calls = []; listFailure = false; createResponse = null;
  localStorage.clear(); sessionStorage.clear();
  useStore.setState({ user: { id: 'user-1' }, isLocked: false, accounts: [account], showAdmin: true });
  globalThis.fetch = async (path, opts) => {
    const method = opts.method;
    const body = opts.body && JSON.parse(opts.body);
    calls.push({ path, method, body, credentials: opts.credentials, headers: opts.headers });
    if (path === '/api/webhooks' && method === 'GET') return listFailure ? response({ error: 'secret-that-must-not-be-displayed' }, 500) : response({ subscriptions, maxSubscriptions: 10 });
    if (path === '/api/webhooks' && method === 'POST') {
      if (createResponse) return createResponse();
      subscriptions = [...subscriptions, { ...subscription, id: 'sub-2', name: body.name }];
      return response({ subscription: subscriptions.at(-1), secret }, 201);
    }
    if (path === '/api/webhooks/sub-1' && method === 'PATCH') { subscriptions[0].enabled = body.enabled; return response({ subscription: subscriptions[0] }); }
    if (path === '/api/webhooks/sub-1/rotate') return response({ secret: 'fixture-rotated-key' });
    if (path === '/api/webhooks/sub-1' && method === 'DELETE') {
      subscriptions = subscriptions.filter(s => s.id !== 'sub-1');
      return response({ ok: true });
    }
    const historyUrl = new URL(path, 'https://mail.example.invalid');
    if (historyUrl.pathname === '/api/webhooks/sub-1/deliveries') {
      const filtered = historyUrl.searchParams.get('status') === 'failed' ? deliveries.filter(d => d.status === 'failed') : deliveries;
      const offset = Number(historyUrl.searchParams.get('offset') || 0);
      const hasMore = filtered.length > offset + 100;
      return response({ deliveries: filtered.slice(offset, offset + 100), pagination: { offset, limit: 100, hasMore, nextOffset: hasMore ? offset + 100 : null } });
    }
    const retryId = path.match(/^\/api\/webhooks\/sub-1\/deliveries\/([^/]+)\/retry$/)?.[1];
    if (retryId) {
      deliveries = deliveries.map(d => d.id === retryId ? { ...d, status: 'pending', attempts: 0, nextAttemptAt: '2026-11-07T00:00:00Z' } : d);
      subscriptions[0].failed = 0;
      return response({ ok: true });
    }
    throw new Error(`Unexpected virtual request: ${method} ${path}`);
  };
});
afterEach(async () => { if (root) await act(async () => root.unmount()); root = null; });

test('create uses mailbox scope and CSRF; secret appears once and stays out of storage/store/URL', async () => {
  await mount();
  await createHook();
  await until(() => host.querySelector('code')?.textContent === secret);
  const post = calls.find(c => c.method === 'POST');
  assert.deepEqual(post.body, { name: 'New fixture', accountId: account.id, url: 'https://receiver.example.invalid/hook?key=target-secret' });
  assert.ok(calls.every(c => c.credentials === 'include' && c.headers['X-Requested-With'] === 'MailFlow'));
  assert.ok(text().includes('New fixture'));
  assert.ok(!text().includes('target-secret'));
  assert.ok(!JSON.stringify(useStore.getState()).includes(secret));
  assert.equal(localStorage.length, 0); assert.equal(sessionStorage.length, 0);
  assert.equal(window.location.search, '');
  await click(btn(en.common.dismiss));
  assert.ok(!text().includes(secret));
  await click(btn(en.admin.webhooks.refresh));
  assert.ok(!text().includes(secret));
});
test('enable/disable roundtrip and rotation use the selected subscription', async () => {
  await mount();
  await click(btn(en.admin.webhooks.disable));
  await until(() => btn(en.admin.webhooks.enable));
  assert.deepEqual(calls.find(c => c.method === 'PATCH').body, { enabled: false });
  await click(btn(en.admin.webhooks.enable));
  await until(() => btn(en.admin.webhooks.disable));
  await click(btn(en.admin.webhooks.rotate));
  assert.equal(host.querySelector('code').textContent, 'fixture-rotated-key');
  assert.ok(calls.some(c => c.path === '/api/webhooks/sub-1/rotate' && c.method === 'POST'));
});
test('failure history shows attempts, backlog and manual retry result', async () => {
  await mount();
  assert.ok(text().includes('Pending: 1 · Failed: 1'));
  await click(btn(en.admin.webhooks.history));
  assert.ok(text().includes('Attempts: 8'));
  assert.ok(text().includes('network_error'));
  await click(btn(en.common.retry));
  assert.ok(text().includes('Awaiting delivery'));
  assert.ok(text().includes('Attempts: 0'));
  assert.ok(text().includes('Pending: 1 · Failed: 0'));
  assert.equal(btn(en.common.retry), undefined, 'pending delivery already has a scheduled attempt');
  deliveries = [{ ...deliveries[0], status: 'failed' }];
  await click(btn(en.admin.webhooks.refresh));
  await click(btn(en.admin.webhooks.disable));
  await until(() => btn(en.admin.webhooks.enable));
  assert.equal(btn(en.common.retry).disabled, true, 'disabled subscriptions cannot be retried');
});
test('load failure is visible, leaks no server text, and refresh recovers', async () => {
  listFailure = true;
  await mount();
  assert.equal(host.querySelector('[role="alert"]').textContent, en.admin.webhooks.loadError);
  assert.ok(!text().includes('secret-that-must-not-be-displayed'));
  assert.ok(!text().includes(en.admin.webhooks.empty));
  listFailure = false;
  await click(btn(en.admin.webhooks.refresh));
  assert.ok(text().includes(subscription.name));
  assert.equal(host.querySelector('[role="alert"]'), null);
});
test('locking or switching identity discards the displayed key and stale creation response', async () => {
  await mount(); await createHook();
  assert.ok(text().includes(secret));
  await act(async () => useStore.setState({ isLocked: true }));
  assert.equal(text(), '');
  await act(async () => useStore.setState({ isLocked: false }));
  assert.ok(!text().includes(secret));
  let resolve;
  createResponse = () => new Promise(done => { resolve = done; });
  await createHook();
  await act(async () => useStore.setState({ user: { id: 'user-2' } }));
  await act(async () => resolve(response({ secret: 'stale-key-from-another-user' })));
  assert.ok(!text().includes('stale-key-from-another-user'));
  assert.ok(!text().includes(secret));
});
test('no enabled mailbox prevents creation; full target remains absent from the list', async () => {
  useStore.setState({ accounts: [{ ...account, enabled: false }] });
  await mount();
  assert.ok(text().includes(en.admin.webhooks.noAccounts));
  assert.equal(btn(en.admin.webhooks.create), undefined);
  assert.ok(text().includes(subscription.targetOrigin));
  assert.equal(host.querySelector('input[type="url"]'), null);
});

test('delete asks first, cancels safely, removes matching history and frees a quota slot', async () => {
  subscriptions = Array.from({ length: 10 }, (_, i) => ({ ...subscription, id: `sub-${i + 1}`, name: `Fixture ${i + 1}` }));
  await mount();
  assert.equal(btn(en.admin.webhooks.create), undefined);
  assert.ok(text().includes(en.admin.webhooks.limitReached));
  await click(btn(en.admin.webhooks.history));
  await click(btn(en.common.delete));
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 0, 'confirmation precedes the request');
  assert.equal(document.activeElement.textContent, en.common.cancel, 'confirmation starts on Cancel');
  await click(btn(en.common.cancel));
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
  await click(btn(en.common.delete));
  const confirmation = host.querySelector('[role="group"]');
  await click([...confirmation.querySelectorAll('button')].find(b => b.textContent === en.common.delete));
  assert.equal(calls.filter(c => c.method === 'DELETE').length, 1);
  assert.ok(![...host.querySelectorAll('strong')].some(el => el.textContent === 'Fixture 1'));
  assert.ok(!text().includes('event-1'), 'deleted subscription history is cleared');
  assert.ok(btn(en.admin.webhooks.create), 'deleting one of ten reopens creation');
  assert.ok(!text().includes(en.admin.webhooks.limitReached));
});

test('failed-only filter finds and retries an old failure beyond 101 recent successful deliveries', async () => {
  deliveries = [
    ...Array.from({ length: 101 }, (_, i) => ({ id: `success-${i}`, eventId: `successful-event-${i}`, status: 'delivered', attempts: 1 })),
    { id: 'old-failure', eventId: 'old-failed-event', status: 'failed', attempts: 8, lastError: 'timeout' },
  ];
  await mount();
  await click(btn(en.admin.webhooks.history));
  assert.ok(!text().includes('old-failed-event'), 'all-deliveries first page contains only recent successes');
  const filter = host.querySelector('input[type="checkbox"]');
  await click(filter);
  assert.ok(text().includes('old-failed-event'), 'failure filter reaches the older failed event directly');
  assert.ok(calls.some(c => c.path === '/api/webhooks/sub-1/deliveries?status=failed&offset=0'));
  await click(btn(en.common.retry));
  assert.ok(calls.some(c => c.path === '/api/webhooks/sub-1/deliveries/old-failure/retry'));
  assert.ok(!text().includes('old-failed-event'), 'retried delivery leaves the failed-only view');
  assert.equal(filter.checked, true, 'retry preserves the filter');
});

test('load more reaches the 101st failure without dropping the first 100 and can retry it', async () => {
  deliveries = Array.from({ length: 101 }, (_, i) => ({ id: `failure-${i}`, eventId: `failed-event-${i}`, status: 'failed', attempts: 8, lastError: 'http_error' }));
  await mount();
  await click(btn(en.admin.webhooks.history));
  await click(host.querySelector('input[type="checkbox"]'));
  assert.equal(host.querySelectorAll('code').length, 100);
  assert.ok(!text().includes('failed-event-100'));
  await click(btn(en.common.loadMore));
  assert.equal(host.querySelectorAll('code').length, 101);
  assert.equal(btn(en.common.loadMore), undefined, 'last page has no further page action');
  assert.ok(calls.some(c => c.path === '/api/webhooks/sub-1/deliveries?status=failed&offset=100'));
  const last = [...host.querySelectorAll('code')].find(el => el.textContent === 'failed-event-100').parentElement;
  await click([...last.querySelectorAll('button')].find(b => b.textContent === en.common.retry));
  assert.ok(calls.some(c => c.path === '/api/webhooks/sub-1/deliveries/failure-100/retry'));
  assert.ok(!text().includes('failed-event-100'));
  assert.equal(host.querySelectorAll('code').length, 100);
});
