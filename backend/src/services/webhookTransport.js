// Core-only outbound boundary. A new connection is pinned to freshly checked DNS
// results for each attempt; neither HTTP redirects nor the private-host setting apply.
import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces, hostname as machineHostname } from 'node:os';
import { resolveForConnection, validateHostLiteral } from './hostValidation.js';

export const WEBHOOK_TIMEOUT_MS = 10_000;

export function webhookTransportError(code) {
  return Object.assign(new Error(code), { code });
}

function parseTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || [...raw].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    throw webhookTransportError('target_rejected');
  }
  let url;
  try { url = new URL(raw); } catch { throw webhookTransportError('target_rejected'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw webhookTransportError('target_rejected');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  let appHost;
  try { appHost = new URL(process.env.APP_URL).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* optional */ }
  if (host === machineHostname().toLowerCase() || host === appHost || validateHostLiteral(host)) {
    throw webhookTransportError('target_rejected');
  }
  return url;
}

function checkAddress(address) {
  const family = isIP(address);
  if (!family || validateHostLiteral(address)) throw webhookTransportError('target_rejected');
  // hostValidation also serves mail servers and permits some non-routable ranges.
  // Webhooks require global unicast; refuse multicast, documentation and transition ranges.
  const reserved = new BlockList();
  for (const [net, bits] of [['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4]]) {
    reserved.addSubnet(net, bits, 'ipv4');
  }
  reserved.addSubnet('2001:db8::', 32, 'ipv6');
  reserved.addSubnet('2002::', 16, 'ipv6');
  reserved.addSubnet('64:ff9b::', 96, 'ipv6');
  if (reserved.check(address, family === 4 ? 'ipv4' : 'ipv6')) throw webhookTransportError('target_rejected');
  if (family === 6 && !address.toLowerCase().startsWith('::ffff:')) {
    const global = new BlockList();
    global.addSubnet('2000::', 3, 'ipv6');
    if (!global.check(address, 'ipv6')) throw webhookTransportError('target_rejected');
  }
  const local = new BlockList();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      const localFamily = isIP(entry.address);
      if (localFamily) local.addAddress(entry.address, localFamily === 4 ? 'ipv4' : 'ipv6');
    }
  }
  if (local.check(address, family === 4 ? 'ipv4' : 'ipv6')) throw webhookTransportError('target_rejected');
}

async function resolveTarget(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let connection;
  try { connection = await resolveForConnection(host); }
  catch { throw webhookTransportError('target_rejected'); }
  // No DNS results means fail closed. A later system lookup must never substitute
  // an unchecked address after this validation.
  const addresses = connection.addresses || (isIP(host) ? [host] : []);
  if (!addresses.length) throw webhookTransportError('target_rejected');
  for (const address of addresses) checkAddress(address);
  return connection;
}

async function withDeadline(run, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(WEBHOOK_TIMEOUT_MS, Math.max(1, timeoutMs)));
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(webhookTransportError('timeout')), { once: true })),
    ]);
  } finally { clearTimeout(timer); }
}

export async function validateWebhookTarget(raw) {
  const url = parseTarget(raw);
  await withDeadline(() => resolveTarget(url), WEBHOOK_TIMEOUT_MS);
  return url.href;
}

export function signWebhook(secret, timestamp, body) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

export async function sendWebhook({ url: raw, secret, eventId, body, timestamp = Math.floor(Date.now() / 1000).toString(), timeoutMs = WEBHOOK_TIMEOUT_MS }) {
  const url = parseTarget(raw);
  return withDeadline(async signal => {
    const connection = await resolveTarget(url);
    if (signal.aborted) throw webhookTransportError('timeout');
    const request = url.protocol === 'https:' ? https.request : http.request;
    return new Promise((resolve, reject) => {
      const req = request({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'POST',
        agent: false,
        lookup: connection.lookup,
        servername: connection.servername || undefined,
        signal,
        maxHeaderSize: 8192,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'MailFlow-Webhook/1',
          'X-MailFlow-Event-Id': eventId,
          'X-MailFlow-Timestamp': timestamp,
          'X-MailFlow-Signature': signWebhook(secret, timestamp, body),
        },
      }, res => {
        const statusCode = res.statusCode;
        // Never read or persist a receiver's response body. A new connection per
        // attempt also prevents a keepalive connection surviving DNS validation.
        res.destroy();
        if (statusCode >= 200 && statusCode < 300) resolve({ statusCode });
        else reject(Object.assign(webhookTransportError(statusCode >= 300 && statusCode < 400 ? 'redirect_rejected' : 'http_error'), { statusCode }));
      });
      req.once('error', () => reject(webhookTransportError(signal.aborted ? 'timeout' : 'network_error')));
      req.end(body);
    });
  }, timeoutMs);
}
