import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { formatDateTime } from '../utils/formatDate.js';

const card = { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 13 };
const button = { padding: '8px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 };
const hint = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, overflowWrap: 'anywhere' };
const fields = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 12, marginBottom: 12 };
const STATUS_KEYS = { pending: 'admin.webhooks.statusPending', processing: 'admin.webhooks.statusProcessing', delivered: 'admin.webhooks.statusDelivered', failed: 'admin.webhooks.statusFailed' };

// Browser-session configuration only. Secrets and complete target URLs never enter the store,
// browser storage or logs. Switching users or locking discards in-flight answers and secrets.
export default function WebhooksSection() {
  const { t } = useTranslation();
  const userId = useStore(s => s.user?.id ?? null);
  const locked = useStore(s => s.isLocked);
  const accounts = useStore(s => s.accounts);
  const id = useId();
  const generation = useRef(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', accountId: '', url: '' });
  const [secret, setSecret] = useState(null);
  const [history, setHistory] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [copied, setCopied] = useState(false);
  const secretRef = useRef(null);
  const dismissRef = useRef(null);
  const titleRef = useRef(null);
  const cancelDeleteRef = useRef(null);
  const live = useCallback((seq) => generation.current === seq && useStore.getState().user?.id === userId && !useStore.getState().isLocked, [userId]);
  const load = useCallback(async (seq) => {
    const next = await api.webhooks.list();
    if (live(seq)) setData({ ...next, userId });
  }, [live, userId]);
  useEffect(() => {
    const seq = ++generation.current;
    setData(null); setError(''); setSecret(null); setHistory(null); setConfirmingDelete(null); setCopied(false); setBusy(false);
    setForm({ name: '', accountId: '', url: '' });
    if (userId && !locked) load(seq).catch(() => { if (live(seq)) setError('admin.webhooks.loadError'); });
    return () => { generation.current = seq + 1; };
  }, [userId, locked, load, live]);
  useEffect(() => { if (secret) dismissRef.current?.focus(); }, [secret]);
  useEffect(() => { if (confirmingDelete) cancelDeleteRef.current?.focus(); }, [confirmingDelete]);

  const run = async (action) => {
    if (busy) return;
    const seq = generation.current;
    setBusy(true); setError('');
    try {
      await action(seq);
    } catch {
      if (live(seq)) setError('admin.webhooks.actionError');
    } finally {
      if (live(seq)) setBusy(false);
    }
  };
  const showSecret = (seq, value, subscriptionId) => {
    if (live(seq)) { setSecret({ userId, value, subscriptionId }); setCopied(false); }
  };
  const loadHistory = async (seq, subscriptionId, failedOnly = false, { offset = 0, append = false } = {}) => {
    const next = await api.webhooks.deliveries(subscriptionId, { ...(failedOnly ? { status: 'failed' } : {}), offset });
    if (live(seq)) setHistory(previous => ({
      id: subscriptionId, failedOnly, userId, pagination: next.pagination,
      deliveries: append && previous?.id === subscriptionId && previous.failedOnly === failedOnly
        ? [...new Map([...previous.deliveries, ...next.deliveries].map(delivery => [delivery.id, delivery])).values()]
        : next.deliveries,
    }));
  };
  const create = (event) => {
    event.preventDefault();
    run(async seq => {
      const created = await api.webhooks.create({ name: form.name.trim(), accountId: form.accountId, url: form.url.trim() });
      showSecret(seq, created.secret, created.subscription.id);
      if (live(seq)) setForm({ name: '', accountId: '', url: '' });
      await load(seq);
    });
  };
  const refresh = () => run(async seq => {
    await load(seq);
    if (history) {
      await loadHistory(seq, history.id, history.failedOnly);
    }
  });
  const availableAccounts = accounts.filter(a => a.enabled !== false);
  const subscriptions = data?.userId === userId ? data.subscriptions ?? [] : [];
  const atLimit = subscriptions.length >= (data?.maxSubscriptions ?? 10);
  const shown = secret?.userId === userId && !locked;
  if (locked) return null;
  return <section style={card} aria-labelledby={`${id}-title`}>
    <h3 ref={titleRef} tabIndex={-1} id={`${id}-title`} style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.webhooks.title')}</h3>
    <p style={hint}>{t('admin.webhooks.description')}</p>
    {error && <p role="alert" style={{ ...hint, color: 'var(--red)' }}>{t(error)}</p>}
    {shown && <div role="status" style={{ ...input, marginBottom: 16 }}>
      <p style={hint}>{t('admin.webhooks.secretNotice')}</p>
      <code ref={secretRef} tabIndex={0} style={{ display: 'block', overflowWrap: 'anywhere', userSelect: 'all', marginBottom: 10 }}>{secret.value}</code>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={button} onClick={async () => {
          const seq = generation.current;
          const ok = await copyToClipboard(secret.value);
          if (!live(seq)) return;
          setCopied(ok);
          if (!ok) { secretRef.current?.focus(); setError('common.copyFailed'); }
        }}>{copied ? t('admin.webhooks.copied') : t('common.copy')}</button>
        <button ref={dismissRef} type="button" style={button} onClick={() => { setSecret(null); titleRef.current?.focus(); }}>{t('common.dismiss')}</button>
      </div>
    </div>}
    {data?.userId !== userId && !error && <p style={hint}>{t('common.loading')}</p>}
    {data?.userId === userId && <>
      {!availableAccounts.length && <p style={hint}>{t('admin.webhooks.noAccounts')}</p>}
      {atLimit && <p style={hint}>{t('admin.webhooks.limitReached')}</p>}
      {!!availableAccounts.length && !atLimit && !shown && <form onSubmit={create}>
        <div style={fields}>
          <label style={hint} htmlFor={`${id}-name`}>{t('admin.webhooks.name')}<input id={`${id}-name`} style={input} value={form.name} maxLength={100} required onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
          <label style={hint} htmlFor={`${id}-account`}>{t('admin.webhooks.account')}<select id={`${id}-account`} style={input} value={form.accountId} required onChange={e => setForm(f => ({ ...f, accountId: e.target.value }))}>
            <option value="" disabled>{t('admin.webhooks.chooseAccount')}</option>
            {availableAccounts.map(account => <option key={account.id} value={account.id}>{account.name || account.email_address}</option>)}
          </select></label>
          <label style={hint} htmlFor={`${id}-url`}>{t('admin.webhooks.target')}<input id={`${id}-url`} type="url" style={input} value={form.url} maxLength={2048} required onChange={e => setForm(f => ({ ...f, url: e.target.value }))} /></label>
        </div>
        <button type="submit" style={button} disabled={busy || !form.name.trim() || !form.accountId || !form.url.trim()}>{t('admin.webhooks.create')}</button>
      </form>}
      {!subscriptions.length && <p style={hint}>{t('admin.webhooks.empty')}</p>}
      <ul style={{ listStyle: 'none', padding: 0, marginBottom: 12 }}>
        {subscriptions.map(subscription => <li key={subscription.id} style={{ borderTop: '1px solid var(--border)', padding: '14px 0', overflowWrap: 'anywhere' }}>
          <strong style={{ fontSize: 13 }}>{subscription.name}</strong>
          <div style={hint}>{accounts.find(a => a.id === subscription.accountId)?.name || accounts.find(a => a.id === subscription.accountId)?.email_address || subscription.accountId}</div>
          <div style={hint}>{subscription.targetOrigin}</div>
          <div style={hint}>{t('admin.webhooks.summary', { pending: subscription.pending ?? 0, failed: subscription.failed ?? 0 })}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" style={button} disabled={busy} aria-pressed={subscription.enabled} onClick={() => run(async seq => {
              await api.webhooks.update(subscription.id, { enabled: !subscription.enabled }); await load(seq);
            })}>{subscription.enabled ? t('admin.webhooks.disable') : t('admin.webhooks.enable')}</button>
            <button type="button" style={button} disabled={busy} onClick={() => run(async seq => {
              const result = await api.webhooks.rotate(subscription.id); showSecret(seq, result.secret, subscription.id);
            })}>{t('admin.webhooks.rotate')}</button>
            <button type="button" style={button} disabled={busy} aria-expanded={history?.id === subscription.id} onClick={() => run(async seq => {
              if (history?.id === subscription.id) { setHistory(null); return; }
              await loadHistory(seq, subscription.id);
            })}>{t('admin.webhooks.history')}</button>
            <button type="button" style={button} disabled={busy} onClick={() => setConfirmingDelete(subscription.id)}>{t('common.delete')}</button>
          </div>
          {confirmingDelete === subscription.id && <div role="group" aria-label={t('admin.webhooks.deleteConfirm')} style={{ marginTop: 10 }}>
            <p style={hint}>{t('admin.webhooks.deleteConfirm')}</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button ref={cancelDeleteRef} type="button" style={button} disabled={busy} onClick={() => { setConfirmingDelete(null); titleRef.current?.focus(); }}>{t('common.cancel')}</button>
              <button type="button" style={{ ...button, color: 'var(--red)' }} disabled={busy} onClick={() => run(async seq => {
                await api.webhooks.delete(subscription.id);
                if (live(seq)) {
                  setConfirmingDelete(null);
                  if (history?.id === subscription.id) setHistory(null);
                  if (secret?.subscriptionId === subscription.id) setSecret(null);
                  titleRef.current?.focus();
                }
                await load(seq);
              })}>{t('common.delete')}</button>
            </div>
          </div>}
          {history?.id === subscription.id && history.userId === userId && <div style={{ marginTop: 10 }}>
            <label style={{ ...hint, display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
              <input type="checkbox" checked={history.failedOnly} disabled={busy} onChange={event => {
                const failedOnly = event.target.checked;
                run(seq => loadHistory(seq, subscription.id, failedOnly));
              }} />{t('admin.webhooks.failedOnly')}
            </label>
            {!history.deliveries.length && <p style={hint}>{t('admin.webhooks.deliveriesEmpty')}</p>}
            {history.deliveries.map(delivery => <div key={delivery.id} style={{ ...hint, padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}>
              <div>{t(STATUS_KEYS[delivery.status] || 'common.unknown')} · {t('admin.webhooks.attempts', { n: delivery.attempts })}</div>
              <code style={{ fontSize: 11 }}>{delivery.eventId}</code>
              {delivery.lastError && <div>{t('admin.webhooks.lastFailure', { reason: delivery.lastError, status: delivery.lastStatus ?? '—' })}</div>}
              {delivery.status === 'pending' && delivery.nextAttemptAt && <div>{t('admin.webhooks.nextAttempt', { date: formatDateTime(delivery.nextAttemptAt) })}</div>}
              {delivery.status === 'failed' && <button type="button" style={{ ...button, marginTop: 6 }} disabled={busy || !subscription.enabled} onClick={() => run(async seq => {
                await api.webhooks.retry(subscription.id, delivery.id);
                await loadHistory(seq, subscription.id, history.failedOnly);
                await load(seq);
              })}>{t('common.retry')}</button>}
            </div>)}
            {history.pagination?.hasMore && <button type="button" style={button} disabled={busy} onClick={() => run(seq => loadHistory(seq, subscription.id, history.failedOnly, {
              offset: history.pagination.nextOffset, append: true,
            }))}>{t('common.loadMore')}</button>}
          </div>}
        </li>)}
      </ul>
    </>}
    <button type="button" style={button} disabled={busy} onClick={refresh}>{t('admin.webhooks.refresh')}</button>
  </section>;
}
