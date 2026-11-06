# MailFlow Plus HTTP API v1

The versioned read API is rooted at `/api/v1`. Its machine-readable contract is
[openapi-v1.json](./openapi-v1.json) (OpenAPI 3.1). It exposes enabled accounts,
cached folder metadata, individual mail rows, message content and search. This
API uses the existing MailFlow API Token system; it does not add sending,
deletion, attachment download or Webhook endpoints.

## Authentication and scope

An administrator must enable API Tokens, then the user creates an expiring token
with the `read` scope in **Settings → Security → API Tokens**. Send it only in the
`Authorization: Bearer <token>` header. The token's user identity determines every
resource scope. Browser cookies alone cannot authenticate v1, and a token request
does not borrow an attached browser session. A missing, malformed, unknown,
expired or revoked token, or the administrator's disabled switch, produces 401.
A valid token without `read` produces 403.

V1 adds five explicit GET entries to the existing token allowlist. Other methods,
trailing slashes, path case changes, encoded path variations and unlisted paths
are refused with 403 for a valid token. Path UUID validation happens in this
allowlist before route parameter validation: a malformed UUID in a path therefore
produces 403, while an invalid `accountId` query parameter produces 400. Use the
canonical paths shown below. Existing unversioned `read`, `organize` and `draft`
routes and token-management behavior retain their existing permissions.

All v1 responses include `Cache-Control: no-store`. Token creation and revocation
remain browser-session operations; do not put tokens in query strings, source
files or application logs.

## Endpoints

| Method and path | Result | Accepted query parameters |
| --- | --- | --- |
| `GET /api/v1/accounts` | Enabled accounts owned by the token user | `limit`, `offset` |
| `GET /api/v1/accounts/{id}/folders` | Cached folders in an owned, enabled account | `limit`, `offset` |
| `GET /api/v1/messages` | Flat message metadata, without marking read | `limit`, `offset`, `accountId`, `folder`, `unreadOnly` |
| `GET /api/v1/messages/{id}` | One live message's metadata, body and attachment metadata | None |
| `GET /api/v1/search` | Matching message metadata from the cached search service | `q`, `limit`, `offset`, `accountId`, `folder` |

Unknown, repeated, array or object query parameters are rejected with 400.
`limit` defaults to 50 and accepts integers 1–200. `offset` defaults to 0 and
accepts integers 0–100000. Use decimal digits, without signs, whitespace,
fractions, leading zeroes or exponent notation. `unreadOnly` accepts exactly
`true` or `false` and defaults to no unread-only filter. `folder` is a nonempty
string of at most 1000 characters without ASCII control characters; it is a
server folder path, not a UUID.

An explicit `accountId` must be a UUID belonging to the token user and currently
enabled. Nonexistent, foreign and disabled accounts all return the same 404;
they never fall back to another mailbox. Folder discovery checks this ownership
before returning folder metadata. A valid account with no matching folder or
messages yields an empty page. Message reads similarly return 404 for missing,
deleted, foreign or disabled-account message rows.

Without `accountId`, message listing means the unified INBOX: only enabled
accounts with `include_in_unified_inbox` enabled participate. Its folder must be
omitted or exactly `INBOX`. To list another folder, supply its owning `accountId`.
Search without `accountId` uses the same participating account set, but searches
folders according to the search rules below. Explicitly selecting an owned
enabled account permits reading it even if it is excluded from the unified inbox.

## Responses, resource IDs and pagination

Every collection returns this envelope; there is no `total` count:

```json
{
  "data": [],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "hasMore": false,
    "nextOffset": null
  }
}
```

`hasMore` is established by reading one extra row. Continue with `nextOffset`
while it is non-null, using the same filters. When the next offset would exceed
100000, `nextOffset` is null even if `hasMore` is true. Narrow the account, folder
or search filters to read beyond that window. Accounts sort by configured order,
creation time and ID; folders sort by path. Ordinary message lists and search
sort by message date descending and row ID ascending for ties. The existing
`Snoozed` view retains its wake time ascending (nulls last), date descending and
ID ascending order. Offset pagination is not a snapshot: arrivals, moves,
deletions and other concurrent changes can shift rows between requests. Clients
that accumulate pages should deduplicate by row ID and refresh as appropriate.

An account is `{ "id": "<uuid>", "name": null, "email": "..." }`; a folder is
`{ "accountId": "<uuid>", "path": "INBOX", "name": "Inbox", "specialUse": null }`.
Nullable account names and folder names are preserved. `specialUse` is the cached
IMAP special-use value, such as `\\Sent`, or null.

Message metadata is an explicit projection, shared by listing, searching and
reading:

| Field | Meaning |
| --- | --- |
| `id`, `accountId` | MailFlow message-row UUID and owning account UUID |
| `folder` | Exact cached server folder path |
| `messageId`, `inReplyTo` | RFC mail header values, or null |
| `subject`, `snippet` | Cached strings, or null |
| `from` | Object with nullable `name` and `email` |
| `to`, `cc`, `replyTo` | Arrays of objects with nullable `name` and `email`; empty when absent |
| `date` | UTC ISO 8601 string, or null |
| `isRead`, `isStarred`, `hasAttachments` | Boolean cached message flags |

The `id` identifies a cached row, not a globally permanent message. Moving or
resynchronizing mail can replace that row and change its UUID. Copies in different
folders or accounts have different row IDs. RFC `messageId` may be absent or
repeated and is not an API resource ID or a uniqueness guarantee. V1 does not
provide a durable-ID resolver. Metadata, search and body caches reflect the
application's current synchronization state rather than a transactionally frozen
mailbox snapshot.

## Message content and attachments

`GET /api/v1/messages/{id}` returns `{ "data": { ...metadata, "body": { "html":
null, "text": "..." }, "attachments": [] } }`. Either body representation may be
null. Cached content is returned directly. If both body representations are null, the
existing mail engine fetches and stores the body using a guarded cache update,
even when attachment metadata is already present from envelope synchronization.
An attachment-only message confirmed by that fetch returns
`body: { "html": null, "text": "" }`; the empty text records a completed body fetch
so subsequent cached reads do not fetch it again. The fetch waits at most 40
seconds. A failed/timed-out fetch or a message changed during that fetch returns
503 (`body_unavailable`); retry or refresh the message list. The underlying engine
operation may finish after a timeout, but this request does not then cache that
late result. Reading does not set the
message's read flag or trigger folder-wide body prefetch. Search reads cached
content and does not hydrate missing bodies.

`body.html` passes through MailFlow's email sanitizer. It is email content, not a
complete application page. Consumers choose their own sandbox and remote-resource
policy when displaying it; v1 does not apply the web UI's image proxy or display
preferences. CID references may remain. `body.text` is the stored plain text.

Attachment objects contain only `part` (string or null), `filename` (string or
null), `contentType` (string or null) and `size` (byte count or null). These are
cached MIME metadata; empty metadata does not create a download URL, and `part`
is not a globally stable attachment ID. V1 does not expose attachment bytes,
raw EML, image proxies, credentials, account connection settings or Bcc fields.

## Search behavior

`q` is required. Its trimmed value must contain at least two characters and the
submitted value must be at most 500 characters. The service searches enabled,
authorized accounts only and excludes deleted rows. It shares the browser's
existing parser and database search:

| Syntax | Meaning |
| --- | --- |
| `from:alice`, `subject:invoice` | Case-insensitive sender/name or subject substring |
| `to:alice` | Substring match against cached To/Cc address JSON |
| `has:attachment`, `has:attachments` | Only messages with attachments |
| `is:unread`, `is:read`, `is:starred` | Cached flag filter |
| `after:2026-01-01`, `before:2026-02-01` | Inclusive lower date bound, exclusive upper bound |
| `in:sent`, `in:"sent mail"` | Case-insensitive exact folder or nested-folder leaf match |
| `in:all` | All folders in the authorized account set, with ordinary Trash exclusion |
| `-from:alice`, `-invoice` | Negate an operator or free-text term |

Quoted values are supported for operators. Repeated operator filters are ANDed;
the last `in:` determines folder scope, and `in:` negation is ignored. An `in:`
operator overrides the `folder` parameter. Without `in:`, `folder` is an exact
folder-path filter. Without either, search spans folders while excluding those
recognized as Trash by their cached special-use value/name. Select Trash
explicitly with `folder` or `in:trash` to search it. `in:all` does not re-include
Trash or accounts excluded from the unified account scope.

Each of the first ten free-text terms must match somewhere in sender, subject,
stored search vector or cached plain-text body; terms shorter than two characters
are ignored. Metadata uses PostgreSQL `ILIKE`, and `%`/`_` retain its wildcard
meaning. Body search uses English full-text stemming, with a simple-dictionary
fallback for stop-word-only terms; the body text fallback is capped at 600000
characters. Unsupported `has:`/`is:` values and invalid dates do not add a filter.
Unknown operator names remain free text. Queries producing no effective search
condition, such as `in:inbox` alone, return an empty page. Search therefore is not
a raw substring scan of every message body or a way to enumerate folders.

## Errors and limits

Errors use `{ "error": { "code": "invalid_request", "message": "..." } }`.
Branch on the stable status/code, not the human-readable message.

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid, unknown or repeated query parameter |
| 401 | `unauthorized` | Token required, invalid, expired, revoked, or tokens disabled |
| 403 | `forbidden` | Missing read scope or method/path not on the token allowlist |
| 404 | `not_found` | Resource not available within the token user's enabled accounts |
| 413 | `payload_too_large` | Existing token request-body limit exceeded |
| 429 | `rate_limited` | Token, user, authentication-failure or search budget exhausted |
| 500 | `internal_error` | Request failed; underlying database/mail errors are not exposed |
| 503 | `body_unavailable` | Body fetch unavailable or message changed during fetch |

The existing limits apply across old and new routes: 600 requests per five minutes
per token and 1200 per five minutes per user. All of one user's tokens also share
60 search requests per minute across unversioned search/contact search and v1
search; this is separate from that user's browser search budget. Malformed or
unknown credentials share the existing 20 failed attempts per 15 minutes per IP.
The token request-body limit remains 1 MiB; these GET endpoints do not require a
request body. A 429 includes `Retry-After` in seconds. Wait that long before
retrying; invalid or expired credentials require replacing the credential.

## Curl examples

These Bash examples use a placeholder host and an environment variable for the
token. Substitute your own instance URL, a `read` token, and resource UUIDs copied
from the preceding responses. The UUID values below are placeholders. On Windows
PowerShell, invoke `curl.exe` to avoid the `curl` alias.

```bash
BASE='https://mailflow.example.com'
export MAILFLOW_API_TOKEN='mfat_REPLACE_WITH_YOUR_READ_TOKEN'

# Discover enabled accounts.
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MAILFLOW_API_TOKEN" \
  "$BASE/api/v1/accounts?limit=50&offset=0"

ACCOUNT_ID='00000000-0000-4000-8000-000000000001'

# Discover exact folder paths in the selected account.
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MAILFLOW_API_TOKEN" \
  "$BASE/api/v1/accounts/$ACCOUNT_ID/folders"

# List the first page of unread mail; use nextOffset for the next request.
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $MAILFLOW_API_TOKEN" \
  --data-urlencode "accountId=$ACCOUNT_ID" \
  --data-urlencode 'folder=INBOX' --data-urlencode 'unreadOnly=true' \
  --data-urlencode 'limit=25' --data-urlencode 'offset=0' \
  "$BASE/api/v1/messages"

MESSAGE_ID='00000000-0000-4000-8000-000000000002'

# Read content and attachment metadata; this does not mark the mail read.
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $MAILFLOW_API_TOKEN" \
  "$BASE/api/v1/messages/$MESSAGE_ID"

# Search; --data-urlencode preserves spaces, quotes and special characters.
curl --fail-with-body --silent --show-error --get \
  -H "Authorization: Bearer $MAILFLOW_API_TOKEN" \
  --data-urlencode "accountId=$ACCOUNT_ID" \
  --data-urlencode 'q=subject:invoice -from:robot is:unread' \
  --data-urlencode 'limit=25' --data-urlencode 'offset=0' \
  "$BASE/api/v1/search"

unset MAILFLOW_API_TOKEN
```

## Compatibility and implementation boundary

Consumers should ignore unknown response fields and preserve nullable values.
Within v1, existing fields, status/error codes and documented parameter semantics
are maintained; compatible additions may introduce optional fields or new
endpoints. A breaking contract change requires a new major path version. The
unversioned browser routes are not covered by this v1 stability promise.

The adapter reuses the existing token auth chain, ownership queries, message list,
search parser/query, mail engine, body store and sanitizer. Its projections keep
internal database columns outside the public contract. It adds no database schema
migration or token format. Rollback removes the v1 adapter and its allowlist
entries; existing tokens and unversioned permissions continue to use the existing
system. Webhook implementation and production deployment are separate work.
