import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { MAX_WEBHOOK_SUBSCRIPTIONS, WebhookError, webhookService } from '../services/webhooks.js';

// Mount immediately after mountApiAuth, before the router: JSON parser errors originate
// before the route stack and may carry err.body containing a credential-bearing URL.
// They must never reach the application's general-purpose error logger.
export function webhookRequestErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(new WebhookError(500, 'Webhook operation failed'));
  res.set('Cache-Control', 'no-store');
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Webhook request too large' });
  }
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return res.status(400).json({ error: 'Invalid webhook JSON' });
  }
  if (err instanceof WebhookError) return res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'Webhook operation failed' });
}

// These browser-session settings are deliberately absent from the API-token allowlist.
export function createWebhookRouter(service = webhookService) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.apiToken) return res.status(403).json({ error: 'API tokens cannot manage webhooks' });
    next();
  });
  router.use(requireAuth);
  router.param('id', uuidParam('id'));
  router.param('deliveryId', uuidParam('deliveryId'));

  const bodyOnly = fields => (req, res, next) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) {
      return res.status(400).json({ error: 'Invalid webhook request' });
    }
    next();
  };

  router.get('/', async (req, res) => {
    res.json({ subscriptions: await service.list(req.session.userId), maxSubscriptions: MAX_WEBHOOK_SUBSCRIPTIONS });
  });
  router.post('/', bodyOnly(['name', 'accountId', 'url']), async (req, res) => {
    res.status(201).json(await service.create(req.session.userId, req.body));
  });
  router.patch('/:id', bodyOnly(['enabled']), async (req, res) => {
    res.json({ subscription: await service.setEnabled(req.session.userId, req.params.id, req.body.enabled) });
  });
  router.post('/:id/rotate', bodyOnly([]), async (req, res) => {
    res.json(await service.rotate(req.session.userId, req.params.id));
  });
  router.delete('/:id', bodyOnly([]), async (req, res) => {
    res.json(await service.remove(req.session.userId, req.params.id));
  });
  router.get('/:id/deliveries', async (req, res) => {
    const { status, offset } = req.query;
    if (Object.keys(req.query).some(key => !['status', 'offset'].includes(key)) ||
        (status !== undefined && status !== 'failed') ||
        (offset !== undefined && (typeof offset !== 'string' || !/^(0|[1-9]\d*)$/.test(offset) || !Number.isSafeInteger(Number(offset))))) {
      return res.status(400).json({ error: 'Invalid delivery filter or offset' });
    }
    res.json(await service.deliveries(req.session.userId, req.params.id, { status, offset: offset === undefined ? 0 : Number(offset) }));
  });
  router.post('/:id/deliveries/:deliveryId/retry', bodyOnly([]), async (req, res) => {
    res.json(await service.retry(req.session.userId, req.params.id, req.params.deliveryId));
  });
  router.use(webhookRequestErrorHandler);
  return router;
}

export default createWebhookRouter();
