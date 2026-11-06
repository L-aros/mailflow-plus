import { query } from './db.js';
import { rememberDroppedRows, takeCarry } from './movedRowCarry.js';

// A baseline is established only from a real SELECT's UIDVALIDITY and UIDNEXT,
// never from message dates or a partially populated local cache. The first SELECT
// after a subscription starts establishes the boundary; existing mail is historical.
export async function prepareWebhookIngest(account, mailbox, folder) {
  if (folder !== 'INBOX') return null;
  const validity = Number(mailbox?.uidValidity), next = Number(mailbox?.uidNext);
  if (!Number.isSafeInteger(validity) || validity <= 0 || !Number.isSafeInteger(next) || next <= 0) return null;
  const active = await query(`SELECT 1 FROM webhook_subscriptions s JOIN email_accounts a ON a.id = s.account_id
    WHERE s.account_id = $1 AND s.user_id = $2 AND s.enabled AND a.enabled AND a.user_id = s.user_id LIMIT 1`,
  [account.id, account.user_id]);
  if (!active.rows.length) return null;
  const { rows } = await query(`INSERT INTO webhook_mailboxes (account_id, uid_validity, uid_next)
    VALUES ($1,$2,$3) ON CONFLICT (account_id) DO UPDATE
    SET uid_next = CASE WHEN webhook_mailboxes.uid_validity = EXCLUDED.uid_validity
      THEN webhook_mailboxes.uid_next ELSE EXCLUDED.uid_next END,
      uid_validity = EXCLUDED.uid_validity RETURNING uid_next`, [account.id, validity, next]);
  return { validity, next: Number(rows[0].uid_next) };
}

// Wrap the existing upsert, retaining its return shape and existing is_new test.
// PostgreSQL commits the mail row, event and delivery records as one statement;
// an outbox failure rolls all of them back. No process-local enqueue or hook.
const uidWrites = new Map();

export async function persistWebhookMessage(context, account, folder, parsed, sql, params) {
  if (!context || parsed.uid < context.next) return query(sql, params);
  // Sync and independent backfill use different IMAP clients. Serialize the same
  // UID in this process before taking a local move carry: the competing upsert
  // must not win PostgreSQL's unique key while the carry holder is awaiting SQL.
  // Carries themselves are process-local, with the same lifetime as this gate.
  const key = `${account.id}\n${folder}\n${context.validity}\n${parsed.uid}`;
  const previous = uidWrites.get(key);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  uidWrites.set(key, gate);
  await previous;
  try { return await persistArrival(context, account, folder, parsed, sql, params); }
  finally {
    release();
    if (uidWrites.get(key) === gate) uidWrites.delete(key);
  }
}

async function persistArrival(context, account, folder, parsed, sql, params) {
  if (!context || parsed.uid < context.next) {
    return query(sql, params);
  }
  // Reserve synchronously before awaiting SQL, so two sync/backfill clients cannot
  // both suppress separate copies using one process-local move carry.
  const carried = takeCarry(account.id, folder, parsed.messageId, parsed.date);
  if (carried) {
    const putBack = () => rememberDroppedRows(folder, [{ ...carried, account_id: account.id,
      message_id: parsed.messageId, date: parsed.date }]);
    try {
      const result = await query(sql, params);
      if (result.rows[0]?.is_new) result.rows[0].movedCarry = carried;
      else putBack();
      return result;
    } catch (err) { putBack(); throw err; }
  }
  const p = params.length;
  return query(`WITH persisted_message AS (${sql}), arrival AS (
    INSERT INTO webhook_events (user_id,account_id,message_id,uid_validity,uid)
    SELECT $${p + 1}::uuid,$1,id,$${p + 2}::bigint,$2 FROM persisted_message
    WHERE is_new AND EXISTS (SELECT 1 FROM email_accounts WHERE id=$1 AND user_id=$${p + 1} AND enabled)
    ON CONFLICT (account_id,uid_validity,uid) DO NOTHING RETURNING id,account_id,user_id
  ), queued AS (
    INSERT INTO webhook_deliveries (event_id,subscription_id)
    SELECT e.id,s.id FROM arrival e JOIN webhook_subscriptions s
      ON s.account_id=e.account_id AND s.user_id=e.user_id AND s.enabled
    ON CONFLICT (event_id,subscription_id) DO NOTHING RETURNING id
  ) SELECT id,is_new FROM persisted_message`, [...params, account.user_id, context.validity]);
}
