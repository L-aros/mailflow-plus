import { findOwnedAccount, findOwnedMessage } from './ownership.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { storeFetchedBody } from './messageBodyStore.js';
import { withoutCidMarker } from '../utils/cidRefs.js';

const addresses = value => Array.isArray(value) ? value.map(a => ({
  name: a.name || null, email: a.address || a.email || null,
})) : [];

// Explicit projections isolate the public contract from internal SELECT additions.
export function messageMetadata(m) {
  return {
    id: m.id, accountId: m.account_id, folder: m.folder, messageId: m.message_id ?? null,
    subject: m.subject ?? null, from: { name: m.from_name ?? null, email: m.from_email ?? null },
    to: addresses(m.to_addresses), cc: addresses(m.cc_addresses), replyTo: addresses(m.reply_to),
    inReplyTo: m.in_reply_to ?? null, date: m.date == null ? null : new Date(m.date).toISOString(),
    snippet: m.snippet ?? null, isRead: Boolean(m.is_read), isStarred: Boolean(m.is_starred),
    hasAttachments: Boolean(m.has_attachments),
  };
}

function attachmentMetadata(attachments) {
  return Array.isArray(attachments) ? attachments.map(a => ({
    part: a.part == null ? null : String(a.part), filename: a.filename ?? null,
    contentType: a.type ?? null, size: Number.isFinite(a.size) ? a.size : null,
  })) : [];
}

export async function readApiMessage(userId, id, imapManager) {
  const message = await findOwnedMessage(userId, id, { live: true, enabledAccount: true });
  if (!message) return null;
  let html = message.body_html;
  let text = message.body_text;
  let attachments = typeof message.attachments === 'string' ? JSON.parse(message.attachments) : message.attachments;
  // No read flags, image proxy requests or background folder prefetches. An uncached body uses
  // the existing mail engine and cache store, guarded against moves/UID reuse during the fetch.
  if (html == null && text == null) {
    try {
      const account = await findOwnedAccount(userId, message.account_id, { enabled: true });
      if (!account || !imapManager) throw new Error('Body unavailable');
      let fetched = await fetchBodyWithDeadline(imapManager.fetchMessageBody(account, message.uid, message.folder));
      if (fetched.html == null && fetched.text == null && !fetched.attachments?.length) throw new Error('Body unavailable');
      // Envelope sync can store attachment metadata before fetching any body. Only a completed
      // attachment-only fetch stores empty text as the existing cache's completion sentinel.
      if (fetched.html == null && fetched.text == null) fetched = { ...fetched, text: '' };
      const stored = await storeFetchedBody(id, fetched, { over: message });
      if (!stored.stored) throw new Error('Message changed during fetch');
      html = stored.sanitized;
      text = stored.safeText;
      attachments = fetched.attachments;
    } catch {
      return { unavailable: true };
    }
  }
  return {
    ...messageMetadata(message),
    body: { html: html ? sanitizeEmail(withoutCidMarker(html)) : null, text: text ?? null },
    attachments: attachmentMetadata(attachments),
  };
}

// Match the internal body reader's overall wait bound. A timed-out engine operation may finish
// later, but its result cannot reach storeFetchedBody through this request.
async function fetchBodyWithDeadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Body fetch timed out')), 40000);
    })]);
  } finally { clearTimeout(timer); }
}
