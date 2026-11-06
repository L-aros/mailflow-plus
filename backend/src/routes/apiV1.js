import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireApiV1Token } from '../middleware/apiV1.js';
import { query } from '../services/db.js';
import { findOwnedAccount } from '../services/ownership.js';
import { listMessages } from '../services/messageService.js';
import { messageMetadata, readApiMessage } from '../services/apiV1Messages.js';
import { searchMessages } from '../services/messageSearch.js';
import { searchLimiter } from './search.js';

const router = Router({ caseSensitive: true, strict: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class InvalidParameters extends Error {}

router.use(requireApiV1Token);
router.use(requireAuth);

function parameters(req, allowed) {
  for (const [key, value] of Object.entries(req.query)) {
    if (!allowed.includes(key) || typeof value !== 'string') throw new InvalidParameters('Unknown or repeated query parameter');
  }
  const integer = (name, fallback, min, max) => {
    const value = req.query[name];
    if (value === undefined) return fallback;
    if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new InvalidParameters(`Invalid ${name}`);
    }
    return Number(value);
  };
  if (req.query.accountId !== undefined && !UUID.test(req.query.accountId)) throw new InvalidParameters('Invalid accountId');
  if (req.query.folder !== undefined && (!req.query.folder || req.query.folder.length > 1000 || [...req.query.folder].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) {
    throw new InvalidParameters('Invalid folder');
  }
  return { limit: integer('limit', 50, 1, 200), offset: integer('offset', 0, 0, 100000) };
}

function page(rows, { limit, offset }, map = row => row) {
  const hasMore = rows.length > limit;
  return { data: rows.slice(0, limit).map(map), pagination: { limit, offset, hasMore, nextOffset: hasMore && offset + limit <= 100000 ? offset + limit : null } };
}

const endpoint = handler => async (req, res, next) => {
  try { await handler(req, res); } catch (err) {
    if (err instanceof InvalidParameters) return res.status(400).json({ error: err.message });
    next(err);
  }
};

async function ownedAccount(req, res, id) {
  const account = await findOwnedAccount(req.session.userId, id, { enabled: true, columns: 'id' });
  if (!account) res.status(404).json({ error: 'Account not found' });
  return account;
}

router.get('/accounts', endpoint(async (req, res) => {
  const paging = parameters(req, ['limit', 'offset']);
  const { rows } = await query('SELECT id, name, email_address FROM email_accounts WHERE user_id = $1 AND enabled = true ORDER BY sort_order, created_at, id LIMIT $2 OFFSET $3',
    [req.session.userId, paging.limit + 1, paging.offset]);
  res.json(page(rows, paging, a => ({ id: a.id, name: a.name ?? null, email: a.email_address })));
}));

router.get('/accounts/:id/folders', endpoint(async (req, res) => {
  const paging = parameters(req, ['limit', 'offset']);
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid account ID' });
  if (!(await ownedAccount(req, res, req.params.id))) return;
  const { rows } = await query('SELECT path, name, special_use FROM folders WHERE account_id = $1 ORDER BY path LIMIT $2 OFFSET $3',
    [req.params.id, paging.limit + 1, paging.offset]);
  res.json(page(rows, paging, f => ({ accountId: req.params.id.toLowerCase(), path: f.path, name: f.name ?? null, specialUse: f.special_use ?? null })));
}));

router.get('/messages', endpoint(async (req, res) => {
  const paging = parameters(req, ['limit', 'offset', 'accountId', 'folder', 'unreadOnly']);
  const { folder = 'INBOX', unreadOnly } = req.query;
  const accountId = req.query.accountId?.toLowerCase();
  if (unreadOnly !== undefined && !['true', 'false'].includes(unreadOnly)) return res.status(400).json({ error: 'Invalid unreadOnly' });
  if (!accountId && folder !== 'INBOX') return res.status(400).json({ error: 'A folder requires accountId' });
  if (accountId && !(await ownedAccount(req, res, accountId))) return;
  const { messages } = await listMessages({ userId: req.session.userId, accountId, folder, unreadOnly, limit: paging.limit + 1, offset: paging.offset, threaded: false });
  res.json(page(messages, paging, messageMetadata));
}));

router.get('/messages/:id', endpoint(async (req, res) => {
  parameters(req, []);
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
  const data = await readApiMessage(req.session.userId, req.params.id, req.app.get('imapManager'));
  if (!data) return res.status(404).json({ error: 'Message not found' });
  if (data.unavailable) return res.status(503).json({ error: 'Message body is temporarily unavailable' });
  res.json({ data });
}));

router.get('/search', searchLimiter, endpoint(async (req, res) => {
  const paging = parameters(req, ['limit', 'offset', 'accountId', 'folder', 'q']);
  const { folder, q } = req.query;
  const accountId = req.query.accountId?.toLowerCase();
  if (!q || q.trim().length < 2 || q.length > 500) return res.status(400).json({ error: 'q must contain 2 to 500 characters' });
  if (accountId && !(await ownedAccount(req, res, accountId))) return;
  const { messages } = await searchMessages({ userId: req.session.userId, q, accountId, folder, limit: paging.limit + 1, offset: paging.offset });
  res.json(page(messages, paging, messageMetadata));
}));

router.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));
export default router;
