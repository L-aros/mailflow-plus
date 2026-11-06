const ERROR_CODES = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
  413: 'payload_too_large', 429: 'rate_limited', 503: 'body_unavailable',
};

// Before the shared auth chain, so its refusals have the v1 contract too.
export function apiV1Response(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  const json = res.json;
  res.json = function (body) {
    if (this.statusCode >= 400 && typeof body?.error === 'string') {
      body = { error: { code: ERROR_CODES[this.statusCode] || 'internal_error', message: body.error } };
    }
    return json.call(this, body);
  };
  next();
}

export function requireApiV1Token(req, res, next) {
  if (!req.apiToken) return res.set('WWW-Authenticate', 'Bearer realm="MailFlow"').status(401).json({ error: 'An API token is required' });
  next();
}

export function apiV1ErrorHandler(_err, _req, res, _next) {
  void _next; // Express identifies error middleware by its four-argument signature.
  // Never expose DB/IMAP errors, credentials, hostnames or mail content.
  res.status(500).json({ error: 'The request could not be completed' });
}
