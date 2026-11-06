# New-mail Webhooks

MailFlow sends `message.received` to a user's HTTP(S) receiver. Configure subscriptions
under **Settings → Security → Webhooks**. The receiver can subsequently read the
resource with a separate existing `read` API token; no token or mail content travels
in the notification.

## Event contract and signature

The JSON request body has this shape:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "type": "message.received",
  "occurredAt": "2026-11-07T00:00:00.000Z",
  "data": {
    "accountId": "22222222-2222-4222-8222-222222222222",
    "messageId": "33333333-3333-4333-8333-333333333333",
    "url": "/api/v1/messages/33333333-3333-4333-8333-333333333333"
  }
}
```

`occurredAt` is the database ingestion time in UTC, not the mail's Date header or
the time a delivery attempt began. `id` persists across automatic and manual delivery
retries. `messageId` is the v1 cache-row UUID, not the RFC Message-ID. Moving/deleting
mail can replace/remove the row; a later API read can return 404. Notifications contain
no subject, sender, recipients, body, attachments, mailbox credentials or API token.

Every attempt carries these headers:

- `X-MailFlow-Event-Id`: the JSON event ID.
- `X-MailFlow-Timestamp`: decimal Unix seconds for this attempt.
- `X-MailFlow-Signature`: `v1=` followed by the lowercase hex HMAC-SHA256 of
  `timestamp + "." + exact_request_body_bytes`, using the one-time signing secret
  as UTF-8 key bytes.

Verify the raw body before JSON parsing, compare signatures with a constant-time
primitive, enforce a five-minute timestamp window, and match the header event ID
to the body ID. Retries get a fresh timestamp/signature while retaining their event ID.
Delivery is at least once and can be duplicated or arrive out of order; acknowledge
only after atomically committing durable event-ID deduplication and your work item.

[Runnable Node/PostgreSQL receiver](./examples/webhook-receiver.mjs) demonstrates
this transaction and raw-byte verification. It uses this repository's installed `pg`
dependency. Start it with `MAILFLOW_WEBHOOK_SECRET` and `DATABASE_URL` set in the
environment, then run `node docs/examples/webhook-receiver.mjs`. It binds only to
`127.0.0.1:8787`; expose `/webhooks/mailflow` through your own public HTTPS reverse
proxy. Production Webhooks deliberately refuse a direct loopback target. The example
stores only event/account/message IDs and times, creates one durable job per event,
and does not fetch mail or log incoming payloads. A separate job consumer should
use a fixed trusted MailFlow base URL and its own read token to retrieve content.
Keep deduplication records for at least as long as manual replay remains possible.

## Outbound network boundary

Targets must be HTTP(S) URLs no longer than 2048 characters, with no username,
password, fragment, whitespace or control characters. URL query strings may contain
receiver credentials, so the target URL is encrypted at rest and management lists
show only its origin. Prefer HTTPS to protect the secret-bearing signature and IDs
in transit. MailFlow does not follow any redirect, including a redirect to another
public HTTPS address.

Creation checks DNS, and every attempt resolves/checks all returned IPv4/IPv6
addresses again. All addresses must pass the shared host validator plus the
Webhook restrictions on documentation, multicast and transition ranges. Private,
loopback, local/link-local, metadata, reserved and this machine's interface addresses
are rejected; the configured `APP_URL` hostname and machine hostname are rejected
as well. A hostname with no validated DNS results fails closed. Actual connections
use only the pinned validated lookup results, with the original TLS hostname/SNI
and normal certificate verification. Connections are not reused across attempts.
The administrator's mail-server private-host setting does not grant Webhooks a
private-network exception, and there is no production bypass for tests.

Each attempt has a ten-second total DNS-plus-HTTP deadline, bounded response headers,
and discards the response body. Only 2xx responses count as successful. Failures
store fixed safe codes (`target_rejected`, `timeout`, `network_error`,
`redirect_rejected`, `http_error`) and an HTTP status when available; they do not
persist response text, raw network errors or secret-bearing URLs.

## What counts as an arrival

Subscriptions belong to one enabled account owned by the signed-in user. The
event concerns a newly persisted **INBOX** UID, including a message already read
on another device. It does not depend on plugins, browser Push, unread state,
notification mute rules or categorization. It records ingestion before rules;
a later rule may move or delete the referenced resource.

The first successful INBOX SELECT with an active subscription stores the server's
UIDVALIDITY and UIDNEXT as a durable baseline. Mail with a UID below that first
UIDNEXT is history, even if discovered by a later partial scan or independent
backfill. Activation starts at this SELECT, not the subscription-create time.
An empty mailbox establishes the same baseline. Unknown/missing UIDVALIDITY or
UIDNEXT emits nothing until a valid baseline can be established. An epoch change
starts a fresh baseline and suppresses the reconstructed history.
The baseline belongs to the account/epoch and survives deletion of its last
subscription. A replacement subscription reuses it: previously uncached mail
above that baseline first observed after replacement can count as an arrival,
even if it reached the server before the replacement was created.

Both ordinary sync and independent backfill use the same atomic persistence
boundary: a UID at/above the baseline discovered by either can produce one event.
This prevents backfill from silently consuming an arrival before normal sync.
Repeated sync, flag changes and cache rebuilding in the same epoch do not produce
a second event: `(account, UIDVALIDITY, UID)` is unique in the durable event table.
The original event ID/resource-row ID remain unchanged during such a rebuild;
the original resource may therefore be unavailable through v1 after cache removal.
RFC Message-ID is deliberately not used as a deduplication key.

Known local moves with a destination UID relocate the cached row without this
ingest path. Moves without a destination UID use MailFlow's existing short-lived
move carry: the matching recovered row is suppressed, reserving each carry once
across concurrent ingest clients. That inherited carry is process-local, expires
after 15 minutes and cannot identify a move after a restart. A server-side move
or copy into INBOX with a new UID is indistinguishable from delivery and counts
as an arrival when it is above the baseline. Other folders never emit this event.

## Management, queue and failure recovery

Use **Settings → Security → Webhooks** to create a named subscription for an
account, enable/disable or delete it, rotate its secret, inspect paginated deliveries
and retry a failed delivery. The history's **Failed only** filter and **Load more**
make older failures accessible even after hundreds of newer successful deliveries.
Up to ten subscriptions per user are stored; deleting one reclaims a slot. The
secret is generated from 32 secure random bytes and displayed only after create
or rotation; copy it before dismissing the panel. The complete target and secret
use the installation's existing AES-256-GCM encryption and `ENCRYPTION_KEY`.
Lists show only the origin; no API token or signing secret can be retrieved later.

The browser-session endpoints below use the existing authentication, screen-lock
and CSRF chain (`X-Requested-With: XMLHttpRequest` for writes). API tokens,
including `read`, `organize` and `draft`, cannot manage subscriptions. Resource
IDs and every management operation are scoped to the session user; foreign IDs
return 404. A disabled/deleted/foreign account cannot supply new deliveries.

| Method/path | JSON request/result |
| --- | --- |
| `GET /api/webhooks` | `{subscriptions, maxSubscriptions}` with pending/failed counts and oldest pending time |
| `POST /api/webhooks` | `{name, accountId, url}` → `{subscription, secret}` |
| `PATCH /api/webhooks/{id}` | `{enabled: true/false}` → `{subscription}` |
| `POST /api/webhooks/{id}/rotate` | `{}` → `{secret}` |
| `DELETE /api/webhooks/{id}` | `{}` (or no body) → `{ok:true}`; deletes subscription and its delivery history |
| `GET /api/webhooks/{id}/deliveries` | `{deliveries, pagination}`; optional `status=failed`, `offset` |
| `POST /api/webhooks/{id}/deliveries/{deliveryId}/retry` | `{}` → `{ok:true}` for a failed record only |

Delivery history sorts by creation time descending, then row ID descending, with
100 rows per page and one lookahead row. `pagination` contains `offset`, `limit`,
`hasMore` and `nextOffset`; pass the returned offset to **Load more**. `offset`
accepts canonical decimal nonnegative safe integers; unsupported/repeated query
parameters are refused. Filtering to `status=failed` occurs before pagination,
so a failure is not hidden by later successful deliveries. Offset pagination is
not a snapshot; the UI deduplicates appended rows and Refresh reloads the current
filter. Deleting requires confirmation in the UI, waits for in-flight sends and
removes only that subscription's history; event identities used by other
subscriptions remain. Create/delete quota changes serialize on the owning user.

The message upsert, event and active-subscription delivery rows commit in one
PostgreSQL statement. An outbox error rolls back the message upsert too. A process
crash loses only the polling timer; the queue and claims remain in PostgreSQL.
The core worker starts after migrations, polls once per second and handles one
delivery per iteration. Multiple core workers use `FOR UPDATE SKIP LOCKED` and
UUID lease tokens. A claim lasts 60 seconds; replaced/expired claims cannot finish
another worker's work. Each send locks its delivery and subscription, so disable
and rotation wait for an already-started attempt (at most the ten-second network
deadline). An account disable can leave an already-authorized attempt in flight.

There are at most **eight automatic attempts**, including an attempt interrupted
by a crash. Failures wait 30, 60, 120, 240, 480, 960 and 1920 seconds; the backoff
function caps at one hour. All non-2xx results, unreachable targets and rejected
addresses consume an attempt. The final failure or final expired lease becomes
`failed` and stays visible. Manual retry resets its attempt budget, preserving
event ID/body. Safe internal failures may additionally use `credential_unavailable`
or `lease_expired`. Successful attempts record status/time without receiver content.

Disabling suspends already-queued deliveries; re-enabling resumes them. Events
persisted while a subscription is disabled are not added to that subscription and
are not replayed on enable. Mail first discovered after re-enable still follows
the baseline above. There is no guaranteed ordering across messages/subscriptions.
A crash after receiver acknowledgment but before the sender commits can repeat the
event, so receiver-side transactional deduplication is required.

Pending count/oldest time expose backlog, and failed count exposes exhausted work.
Delivered/failed records are retained until the subscription, owning account or user is deleted;
there is no automatic retention cleanup in this version. Large installations
should monitor database size and backlog in addition to setting receiver capacity.

## Modules, migration, backups and disabling

`webhookIngest.js` wraps the existing sync/backfill upserts; `webhooks.js` owns
subscription storage and durable claims; `webhookTransport.js` alone performs
outbound HTTP. `routes/webhooks.js` adapts browser management and sanitizes parser
errors before the general logger. The existing settings components and locales
provide the UI. No plugin capability, raw plugin DB access or network bypass is
added. No new dependency, API-token scope, OpenAPI endpoint or environment setting
is required. The worker's defaults above are fixed in core for this version.

Migration `0076_webhooks` uses the existing transactional migration runner and adds
four tables: subscriptions, mailbox baselines, events and delivery state/indexes.
It does not rewrite mail or existing token rows. The event has no message-row FK,
so mail removal does not erase pending delivery evidence. All four tables belong
to **setup and full** application backups: pending work is not disposable cache.
A setup backup can retain event references whose mail cache was omitted; the
original resource can return 404. Keep the matching `ENCRYPTION_KEY` separately
with the other installation secrets, as required for existing credentials.

Restore disables every subscription to prevent a second installation from
automatically replaying work. It clears processing leases; interrupted attempts
below the limit become pending and exhausted attempts become failed/manual-retryable.
An operator must inspect the receiver, duplicates and queue before enabling.
These restore normalization statements are tested separately; a complete instance
backup/restore drill is a later operational stage.

To suspend the feature now, disable subscriptions in settings (in-flight sends
finish as described above). To roll back code after deployment, stop writes and
restore a **matching pre-0076 database/configuration snapshot** with the previous
application version, or prepare a separately reviewed reverse migration after
exporting any queue evidence. Older backup code rejects unclassified new tables,
so code-only downgrade is not a supported backup workflow. This feature does not
perform a reverse migration, deployment, tag or release.

## Verification boundary

Repository tests use isolated real PostgreSQL databases, virtual mail envelopes
through `syncMessages`/`backfillMessages`, and a virtual HTTP receiver. Restart
tests launch a separate worker process, terminate it after receiver commit, then
recover the expired claim in another process. A test-only injected transport
allows that loopback fixture; production has no corresponding bypass. Transport
tests independently verify an actual loopback target is refused with zero received
requests, and use controlled DNS/request adapters to validate public-address
pinning, redirects, timeout, HTTPS options and exact wire signatures. No external
receiver, real mailbox, real email send or production server is needed or contacted.
