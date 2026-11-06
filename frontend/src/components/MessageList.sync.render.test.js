// Exercise the user's actual sync controls and the existing toast/announcer, with virtual
// responses only. The shared render suite covers the successful 5s/15s socket fallback too.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

const english = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: `
        const en = ${JSON.stringify(english)};
        const t = (key, opts) => {
          const value = key.split('.').reduce((v, k) => v?.[k], en);
          return typeof value === 'string' ? value : (typeof opts === 'string' ? opts : opts?.defaultValue ?? key);
        };
        export const useTranslation = () => ({ t, i18n: { language: 'en', changeLanguage() {} } });
        export const initReactI18next = { type: '3rdParty', init() {} };
        export const Trans = ({ children }) => children ?? null;
        export const I18nextProvider = ({ children }) => children ?? null;
      ` };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimEnv = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true, __VITE_ENV__: { MODE: 'test', DEV: false, PROD: true },
});
window.matchMedia = () => ({ matches: window.innerWidth < 768, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
window.ResizeObserver = globalThis.ResizeObserver;
window.Element.prototype.scrollIntoView = () => {};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const MessageList = (await import('./MessageList.jsx')).default;
const NotificationToasts = (await import('./NotificationToasts.jsx')).default;
const account = { id: 'sync-account', email_address: 'sync@example.invalid', name: 'Sync fixture', include_in_unified_inbox: true };
let root;
let calls;
let syncResponse;
let folderResponse;
const response = (status = 200, body = {}) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
const button = () => document.querySelector(`button[title="${english.messageList.syncAccount}"], button[aria-label="${english.messageList.sync}"]`);
const spinning = () => button().querySelector('svg').style.animation !== 'none';
const act = async (fn) => React.act(async () => { await fn(); });

async function mount({ mobile = false, folder = 'INBOX' } = {}) {
  calls = [];
  syncResponse = async () => response();
  folderResponse = async () => response();
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url);
    calls.push({ path, body: opts.body && JSON.parse(opts.body) });
    if (path.endsWith('/mail/sync')) return syncResponse();
    if (path.endsWith('/mail/sync-folder')) return folderResponse();
    return response(200, path.includes('/mail/messages?') ? { messages: [], total: 0 } : {});
  };
  window.innerWidth = mobile ? 393 : 1024;
  useStore.setState({
    accounts: [account], accountsReady: true, selectedAccountId: account.id, selectedFolder: folder,
    messages: [], messagesTotal: 0, hasMoreMessages: false, loadingMessages: false,
    searchQuery: '', threadedView: false, notifications: [], selectedMessageId: null,
    folders: { [account.id]: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent', special_use: '\\Sent' }] },
  });
  await act(() => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(React.Fragment, null, React.createElement(MessageList), React.createElement(NotificationToasts)));
  });
}

afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  useStore.setState({ notifications: [] });
});

function assertFailureNotice() {
  const notices = useStore.getState().notifications;
  assert.equal(notices.length, 1, 'one notification for this failed action');
  assert.equal(notices[0].type, 'error');
  assert.equal(notices[0].title, 'Sync failed');
  assert.equal(notices[0].body, 'Check your connection and try syncing again.');
  assert.equal(notices[0].allowWrap, true, 'the instructions can wrap on a narrow phone');
  const toast = document.querySelector('.toast-enter, .toast-enter-mobile');
  assert.ok(toast?.textContent.includes(notices[0].title), 'the notice is visible');
  assert.ok(toast?.textContent.includes(notices[0].body), 'the retry instructions are visible');
  assert.ok(document.querySelector('[role="alert"]').textContent.includes(notices[0].body), 'the error is announced');
  assert.equal(button().disabled, false, 'the control accepts a retry');
  assert.equal(spinning(), false, 'the spinner has ended');
}

test('a rejected button request shows one readable error and stops loading', async (t) => {
  await mount();
  t.mock.method(console, 'error', () => {});
  let reject;
  syncResponse = () => new Promise((_, fail) => { reject = fail; });
  await act(() => button().click());
  assert.equal(button().disabled, true);
  assert.equal(spinning(), true);
  await act(() => reject(new TypeError('Failed to fetch')));
  assertFailureNotice();
});

test('mobile pull-to-refresh reports a failure once and can retry after recovery', async (t) => {
  await mount({ mobile: true });
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncResponse = async () => response(503, { error: 'fixture unavailable' });
  const list = document.querySelector('[tabindex="0"]');
  await act(() => {
    for (const [type, y] of [['touchstart', 100], ['touchmove', 260], ['touchend', 260]]) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: [{ clientX: 180, clientY: y }] });
      list.dispatchEvent(event);
    }
  });
  assert.equal(calls.filter(c => c.path.endsWith('/mail/sync')).length, 1);
  assertFailureNotice();
  await act(() => useStore.setState({ notifications: [] }));
  syncResponse = async () => response();
  await act(() => button().click());
  assert.equal(calls.filter(c => c.path.endsWith('/mail/sync')).length, 2, 'the recovered retry reached the server');
  assert.equal(button().disabled, true);
  await act(() => window.dispatchEvent(new CustomEvent('mailflow:sync_done')));
  await act(() => t.mock.timers.tick(1200));
  assert.equal(button().disabled, false);
  assert.equal(spinning(), false);
  assert.deepEqual(useStore.getState().notifications, [], 'successful recovery adds no failure toast');
});

test('a manual folder-sync rejection shares the error path after syncNow succeeds', async (t) => {
  await mount({ folder: 'Sent' });
  t.mock.method(console, 'error', () => {});
  calls = [];
  folderResponse = async () => response(503, { error: 'fixture unavailable' });
  await act(() => button().click());
  assert.deepEqual(calls.filter(c => /\/mail\/sync(?:-folder)?$/.test(c.path)).map(c => c.path), ['/api/mail/sync', '/api/mail/sync-folder']);
  assertFailureNotice();
});

test('an automatic folder sync failure remains quiet', async (t) => {
  await mount();
  t.mock.method(console, 'error', () => {});
  folderResponse = async () => response(503, { error: 'fixture unavailable' });
  await act(() => useStore.setState({ selectedFolder: 'Sent' }));
  assert.ok(calls.some(c => c.path.endsWith('/mail/sync-folder')), 'the on-open sync ran');
  assert.deepEqual(useStore.getState().notifications, []);
  assert.equal(button().disabled, false);
});

test('a completed sync cannot use an old fallback to stop a pending retry', async (t) => {
  await mount();
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  await act(() => button().click());
  await act(() => window.dispatchEvent(new CustomEvent('mailflow:sync_done')));
  await act(() => t.mock.timers.tick(1200));
  let reject;
  syncResponse = () => new Promise((_, fail) => { reject = fail; });
  await act(() => button().click());
  await act(() => t.mock.timers.tick(15000));
  assert.equal(button().disabled, true, 'only the current attempt controls its spinner');
  await act(() => reject(new TypeError('Failed to fetch')));
  assertFailureNotice();
});
