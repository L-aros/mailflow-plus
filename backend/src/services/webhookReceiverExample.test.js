import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { acceptWebhook, createReceiver, parseWebhook, verifyWebhook } from '../../../docs/examples/webhook-receiver.mjs';

const secret = 'test-only-receiver-key';
const event = {
  id: '11111111-1111-4111-8111-111111111111', type: 'message.received', occurredAt: '2026-11-07T00:00:00.000Z',
  data: { accountId: '22222222-2222-4222-8222-222222222222', messageId: '33333333-3333-4333-8333-333333333333', url: '/api/v1/messages/33333333-3333-4333-8333-333333333333' },
};
const body = Buffer.from(JSON.stringify(event));
function signed(timestamp = String(Math.floor(Date.now() / 1000)), value = body) {
  return { secret, timestamp, body: value, signature: 'v1=' + createHmac('sha256', secret).update(timestamp + '.').update(value).digest('hex') };
}

describe('runnable receiver example', () => {
  it('verifies exact bytes and timestamp with a constant-time HMAC comparison', () => {
    const valid = signed();
    expect(verifyWebhook(valid)).toBe(true);
    expect(verifyWebhook({ ...valid, secret: 'wrong' })).toBe(false);
    expect(verifyWebhook({ ...valid, signature: 'v1=abc' })).toBe(false);
    expect(verifyWebhook({ ...valid, body: Buffer.concat([body, Buffer.from(' ')]) })).toBe(false);
    expect(verifyWebhook(signed(String(Math.floor(Date.now() / 1000) - 301)))).toBe(false);
    expect(verifyWebhook(signed(String(Math.floor(Date.now() / 1000) + 301)))).toBe(false);
  });

  it('requires header event id and body id to agree and limits resource paths', () => {
    expect(parseWebhook(body, event.id)).toEqual(event);
    expect(() => parseWebhook(body, event.data.accountId)).toThrow('invalid_event');
    expect(() => parseWebhook(Buffer.from(JSON.stringify({ ...event, data: { ...event.data, url: 'https://evil.example/' } })), event.id)).toThrow('invalid_event');
  });

  it('commits durable dedup and work together and skips repeated events', async () => {
    let duplicate = false;
    const client = { query: vi.fn(async sql => sql.includes('RETURNING event_id') ? { rowCount: duplicate ? 0 : 1 } : {}), release: vi.fn() };
    const pool = { connect: async () => client };
    expect(await acceptWebhook(pool, event)).toEqual({ duplicate: false });
    expect(client.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
    duplicate = true;
    client.query.mockClear();
    expect(await acceptWebhook(pool, event)).toEqual({ duplicate: true });
    expect(client.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'INSERT', 'COMMIT']);
  });

  it('rolls back both dedup and work on failure before acknowledgement', async () => {
    const client = { query: vi.fn(async sql => {
      if (sql.includes('webhook_receiver_jobs')) throw new Error('database failed');
      return { rowCount: 1 };
    }), release: vi.fn() };
    await expect(acceptWebhook({ connect: async () => client }, event)).rejects.toThrow('database failed');
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('accepts signed real HTTP bytes, rejects a wrong signature and never logs payloads', async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 1 })), release: vi.fn() };
    const server = createReceiver({ pool: { connect: async () => client }, secret });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const log = vi.spyOn(console, 'log');
    async function post(signature) {
      const { timestamp } = signed();
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/webhooks/mailflow', method: 'POST', headers: {
          'X-MailFlow-Event-Id': event.id, 'X-MailFlow-Timestamp': timestamp, 'X-MailFlow-Signature': signature,
        } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end(body);
      });
    }
    try {
      expect(await post(signed().signature)).toBe(204);
      expect(await post('v1=' + '0'.repeat(64))).toBe(401);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); await new Promise(resolve => server.close(resolve)); }
  });
});
