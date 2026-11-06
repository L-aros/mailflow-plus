import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (k) => k; export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shim = code => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shim(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shim(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const frontendSha = 'a'.repeat(40);
const backendSha = 'b'.repeat(40);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true, VITE_BUILD_SHA: frontendSha };
globalThis.fetch = async () => ({ ok: true, json: async () => ({
  version: '4.3.0-plus.test', sha: backendSha,
  sourceUrl: `https://github.com/L-aros/mailflow-plus/tree/${backendSha}`,
}) });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const AdminPanel = (await import('./AdminPanel.jsx')).default;
const LoginPage = (await import('./LoginPage.jsx')).default;
let root;
afterEach(() => React.act(async () => root.unmount()));

test('ordinary user About links each running component to its own exact source', async () => {
  useStore.setState({ user: { id: 'ordinary-user', isAdmin: false }, adminTab: 'about' });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(AdminPanel)); });
  assert.ok(document.body.textContent.includes('MailFlow Plus'));
  for (const sha of [frontendSha, backendSha]) {
    const link = document.querySelector(`a[href="https://github.com/L-aros/mailflow-plus/tree/${sha}"]`);
    assert.ok(link, `${sha} has a corresponding source link`);
    assert.equal(link.style.overflowWrap, 'anywhere', 'long source URLs wrap on mobile');
  }
  assert.ok(document.body.textContent.includes('frontend/package.json: GPL-3.0'));
});

test('login page offers the built frontend source without requiring a session', async () => {
  useStore.setState({ user: null });
  api.getRegistrationStatus = async () => ({ open: false });
  api.oidc.getProviders = async () => ({ providers: [] });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(LoginPage)); });
  const link = document.querySelector(`a[href="https://github.com/L-aros/mailflow-plus/tree/${frontendSha}"]`);
  assert.ok(link);
  assert.match(link.textContent, /MailFlow Plus/);
});
