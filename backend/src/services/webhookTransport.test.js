import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';

const state = vi.hoisted(() => ({ request: vi.fn(), resolve4: vi.fn(), resolve6: vi.fn(), lookup: vi.fn(), interfaces: vi.fn() }));
vi.mock('dns', async original => ({
  ...(await original()),
  promises: { resolve4: state.resolve4, resolve6: state.resolve6, lookup: state.lookup },
}));
vi.mock('node:http', async original => {
  const actual = await original();
  return { ...actual, default: { ...actual.default, request: state.request } };
});
vi.mock('node:https', async original => {
  const actual = await original();
  return { ...actual, default: { ...actual.default, request: state.request } };
});
vi.mock('node:os', async original => ({ ...(await original()), networkInterfaces: state.interfaces }));

import { sendWebhook, signWebhook, validateWebhookTarget } from './webhookTransport.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const input = { url: 'https://receiver.example/events?key=not-logged', secret: 'test-only-secret', eventId, body: '{"id":"test"}', timestamp: '1794000000' };

function respond(statusCode = 204) {
  state.request.mockImplementation((options, callback) => {
    const req = new EventEmitter();
    req.end = vi.fn(() => queueMicrotask(() => callback({ statusCode, destroy: vi.fn() })));
    req.options = options;
    return req;
  });
}

beforeEach(() => {
  vi.useRealTimers();
  state.resolve4.mockReset().mockResolvedValue(['93.184.216.34']);
  state.resolve6.mockReset().mockResolvedValue([]);
  state.lookup.mockReset().mockResolvedValue([]);
  state.interfaces.mockReset().mockReturnValue({ Ethernet: [{ address: '10.0.0.4', family: 'IPv4' }] });
  state.request.mockReset();
  respond();
});
afterEach(() => { vi.useRealTimers(); });

describe('webhook target validation and pinned connection', () => {
  it.each([
    'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/',
    'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/', 'http://192.168.1.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fc00::1]/',
    'http://224.0.0.1/', 'http://192.0.2.1/', 'http://[ff02::1]/', 'http://[2001:db8::1]/',
    'ftp://receiver.example/', 'https://user:secret@receiver.example/', 'https://receiver.example/#secret',
    'https://receiver.example/\nsecret', 'https://receiver.example/' + 'a'.repeat(2048),
  ])('rejects %s without an HTTP request', async url => {
    await expect(sendWebhook({ ...input, url })).rejects.toMatchObject({ code: 'target_rejected' });
    expect(state.request).not.toHaveBeenCalled();
  });

  it('rejects all addresses when one DNS answer is private', async () => {
    state.resolve6.mockResolvedValue(['::1']);
    await expect(validateWebhookTarget(input.url)).rejects.toMatchObject({ code: 'target_rejected' });
    expect(state.request).not.toHaveBeenCalled();
  });

  it('fails closed on empty DNS including system resolver fallback', async () => {
    state.resolve4.mockResolvedValue([]);
    await expect(sendWebhook(input)).rejects.toMatchObject({ code: 'target_rejected' });
    expect(state.lookup).toHaveBeenCalled();
    expect(state.request).not.toHaveBeenCalled();
  });

  it('rejects local NIC public addresses and the configured instance hostname', async () => {
    state.interfaces.mockReturnValue({ eth0: [{ address: '93.184.216.34', family: 'IPv4' }] });
    await expect(validateWebhookTarget(input.url)).rejects.toMatchObject({ code: 'target_rejected' });
    const old = process.env.APP_URL;
    process.env.APP_URL = 'https://receiver.example';
    try { await expect(validateWebhookTarget(input.url)).rejects.toMatchObject({ code: 'target_rejected' }); }
    finally { if (old === undefined) delete process.env.APP_URL; else process.env.APP_URL = old; }
  });

  it('rechecks DNS on send and rejects rebinding after subscription validation', async () => {
    await expect(validateWebhookTarget(input.url)).resolves.toBe(input.url);
    state.resolve4.mockResolvedValue(['127.0.0.1']);
    await expect(sendWebhook(input)).rejects.toMatchObject({ code: 'target_rejected' });
    expect(state.request).not.toHaveBeenCalled();
  });

  it('pins every socket lookup to the checked addresses, retains SNI and exact request bytes', async () => {
    expect(await sendWebhook(input)).toEqual({ statusCode: 204 });
    const [options] = state.request.mock.calls[0];
    expect(options).toMatchObject({ agent: false, hostname: 'receiver.example', servername: 'receiver.example', path: '/events?key=not-logged', method: 'POST' });
    expect(options.headers['X-MailFlow-Signature']).toBe(`v1=${createHmac('sha256', input.secret).update(input.timestamp + '.' + input.body).digest('hex')}`);
    const before = state.resolve4.mock.calls.length;
    state.resolve4.mockResolvedValue(['127.0.0.1']);
    const pinned = await new Promise((resolve, reject) => options.lookup('receiver.example', { all: true }, (err, answers) => err ? reject(err) : resolve(answers)));
    expect(pinned).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(state.resolve4).toHaveBeenCalledTimes(before);
    expect(state.request.mock.results[0].value.end).toHaveBeenCalledWith(input.body);
  });

  it('supports direct public IPs with no later resolver', async () => {
    await expect(sendWebhook({ ...input, url: 'http://93.184.216.34/events' })).resolves.toEqual({ statusCode: 204 });
    expect(state.resolve4).not.toHaveBeenCalled();
  });

  it('never follows redirects and never exposes response bodies or secret URLs', async () => {
    respond(302);
    await expect(sendWebhook(input)).rejects.toMatchObject({ code: 'redirect_rejected', message: 'redirect_rejected', statusCode: 302 });
    expect(state.request).toHaveBeenCalledTimes(1);
    respond(503);
    await expect(sendWebhook(input)).rejects.toMatchObject({ code: 'http_error', message: 'http_error', statusCode: 503 });
  });

  it('converts socket failures to safe codes', async () => {
    state.request.mockImplementation(() => {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => req.emit('error', new Error(input.url)));
      return req;
    });
    await expect(sendWebhook(input)).rejects.toMatchObject({ code: 'network_error', message: 'network_error' });
  });

  it('bounds DNS and HTTP within the same timeout', async () => {
    vi.useFakeTimers();
    state.resolve4.mockImplementation(() => new Promise(() => {}));
    const result = expect(sendWebhook({ ...input, timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(51);
    await result;
    expect(state.request).not.toHaveBeenCalled();
  });

  it('actually refuses an active loopback HTTP receiver without hitting it', async () => {
    const actual = await vi.importActual('node:http');
    let requests = 0;
    const server = actual.createServer((req, res) => { requests++; res.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await expect(sendWebhook({ ...input, url: `http://127.0.0.1:${server.address().port}/` })).rejects.toMatchObject({ code: 'target_rejected' });
      expect(requests).toBe(0);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('sends signed bytes to a virtual HTTP receiver through a test-only request adapter', async () => {
    // This exercises the actual HTTP wire and receiver bytes, while the injected
    // request adapter maps a validated public fixture hostname to the local server.
    // Production validation has no private-address bypass.
    const actual = await vi.importActual('node:http');
    let received;
    const server = actual.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = { body: Buffer.concat(chunks).toString(), headers: req.headers };
      res.writeHead(204).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    state.request.mockImplementation((options, callback) => actual.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port, lookup: undefined }, callback));
    try {
      expect(await sendWebhook({ ...input, url: 'http://receiver.example/events' })).toEqual({ statusCode: 204 });
      expect(received.body).toBe(input.body);
      expect(received.headers['x-mailflow-signature']).toBe(signWebhook(input.secret, input.timestamp, input.body));
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
