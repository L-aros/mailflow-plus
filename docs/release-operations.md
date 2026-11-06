# MailFlow Plus: prepared images, recovery and rollback

This guide describes a local Linux Docker installation and the isolated preparation
workflow. Production deployment, a registry account, public visibility, a public
domain and off-site storage have not been configured by this stage. The Docker
runner uses synthetic accounts and mail. Do not use an existing production database
or mailbox as the rehearsal target.

## Select and verify a prepared version

Use the **CI** run for the exact reviewed source SHA. Its **Plus images and recovery
drill** (`prepare`) job depends on
both existing Backend and Frontend checks. A failed prerequisite produces no
prepared image bundle. PR preparation checks out the PR head explicitly, rather
than publishing a different merge commit. The bundle is a GitHub Actions artifact
named `mailflow-plus-<full-source-SHA>`, retained for 30 days; download it from that
run's artifact list while signed in. Copy it to your own retention location before
expiry. This is an offline preparation artifact, not a registry release.

The bundle contains `release-manifest.json`, `SHA256SUMS`, candidate backend and
frontend Docker/OCI archives, the recorded old baseline archives, a fixed-SHA source
archive, and the deployment files. Check the run conclusion, source SHA and
rehearsal result before selecting a candidate. An uploaded failure log is not a
passing preparation. A version string alone is not sufficient evidence.

```bash
sha256sum -c SHA256SUMS
docker load -i candidate-backend.docker.tar
docker load -i candidate-frontend.docker.tar
docker load -i dependencies.docker.tar
```

`release-manifest.json` distinguishes the OCI manifest digest, image configuration
digest / loaded Docker image ID, and archive-file SHA256. A Docker archive checksum
is not a registry manifest digest. Registry manifest digest is `null` until an
explicitly authorized registry push has actually occurred. Docker archives are for
`docker load`; OCI archives retain their separate OCI manifest for verification.
This preparation targets Linux amd64; do not assume an arm64 image was built.

The backend and frontend must both have the same candidate source revision and
Plus version. After loading, inspect the labels and compare them with the manifest:

```bash
docker image inspect mailflow-plus/backend:sha-<full-source-SHA> \
  --format '{{.Id}} {{json .Config.Labels}}'
docker image inspect mailflow-plus/frontend:sha-<full-source-SHA> \
  --format '{{.Id}} {{json .Config.Labels}}'
```

The original root AGPL-3.0 license, commercial-license text and component package
metadata remain in the source and image. The frontend package's existing GPL-3.0
identifier is preserved separately; this guide does not reinterpret it. The running
Plus version/source entry points link to the actual fixed source SHA. Retain and
serve that corresponding source when providing the modified network service.

## Run your Plus images

Requires Docker Engine and Docker Compose **2.24.4 or later** (the Compose files use
`!reset` / `!override`). Run commands from the extracted deployment directory, which
contains both `docker-compose.yml` and `docker-compose.plus.yml`. The Plus entry
extends the existing services, removes their fixed container names, and requires
both explicit image references. `docker-compose.ghcr.yml` continues to describe the
original upstream images and does not contain the Plus enhancements.

```bash
# From a source checkout:
cp .env.plus.example .env
# From the downloaded deployment bundle instead:
# cp env.plus.example .env
chmod 600 .env
# Fill the three independent secrets and set the exact two candidate tags:
# MAILFLOW_BACKEND_IMAGE=mailflow-plus/backend:sha-<full-source-SHA>
# MAILFLOW_FRONTEND_IMAGE=mailflow-plus/frontend:sha-<full-source-SHA>
docker compose -p mailflow-plus --env-file .env -f docker-compose.plus.yml config --quiet
docker compose -p mailflow-plus --env-file .env -f docker-compose.plus.yml \
  up -d --no-build --pull never --wait --wait-timeout 180
```

The Plus example binds HTTP/HTTPS to localhost on 8080/8443. Its self-signed HTTPS
certificate is for local initialization, not public trusted HTTPS. Do not copy
`APP_PORT=443` / `APP_HTTP_PORT=80` from the upstream example unnoticed: those values
bind on all interfaces. A future authorized registry installation can set each
`MAILFLOW_*_IMAGE` to its own `registry/repository@sha256:<manifest-digest>` and use
the normal authenticated pull process. Never substitute upstream `latest` for a
missing Plus image.

The bundle's `dependencies.docker.tar` contains the actual PG16/Redis7 images used
by the runner. Its manifest records their loaded image IDs and the official
registry `RepoDigests` from the pull. Loading that archive supplies the dependency
tags for an offline default Compose installation. Optional Caddy is not included;
obtain and record its image separately before enabling that profile. The running
snapshot records exact database/Redis image IDs as well as both application IDs.
Keep these matched images alongside the snapshot. Neither tag alone nor a future
pull of the same mutable tag guarantees an exact restore image.

To build from the corresponding source instead, use a clean checkout/archive and
record the full SHA yourself:

```bash
export GIT_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
export PLUS_VERSION="4.3.0-plus.sha-$GIT_SHA"
export MAILFLOW_BACKEND_IMAGE="mailflow-plus/backend:sha-$GIT_SHA"
export MAILFLOW_FRONTEND_IMAGE="mailflow-plus/frontend:sha-$GIT_SHA"
docker pull postgres:16-alpine
docker pull redis:7-alpine
docker compose --env-file .env -f docker-compose.plus.yml \
  -f docker-compose.plus-build.yml build
docker compose --env-file .env -f docker-compose.plus.yml \
  up -d --no-build --pull never --wait --wait-timeout 180
```

For an extracted source archive without Git metadata, supply the SHA/version from
its verified release manifest instead. The Compose arguments are provenance
inputs; they cannot prove a dirty checkout is equivalent to the recorded source.

## Persistence inventory

| Store / mounted path | Contents and treatment |
| --- | --- |
| `postgres_data` or `POSTGRES_DATA` → `/var/lib/postgresql/data` | Database, users/password hashes, encrypted mailbox/OAuth credentials, settings, message cache, scheduled messages/attachments, API-token hashes, migration ledger, and all four Webhook tables. Use a consistent logical PG custom-format dump, not a live directory copy. |
| `redis_data` or `REDIS_DATA` → `/data` | Sessions and disposable cache. Preserve the files in an instance snapshot, but this restore script flushes the dedicated restored instance to invalidate old sessions. Do not flush a shared Redis. |
| `image_cache` → `/var/cache/mailflow/images` | Fitted-image disk cache. Regenerable, but included in the generic snapshot to preserve the actual mounted state. This does not replace the database message cache. |
| `./certs` → frontend `/etc/nginx/ssl` | Supplied/generated TLS certificate and private key. Included and encrypted. |
| `.env` and actual backend/container environment | `ENCRYPTION_KEY`, session secret, DB password, optional OAuth/VAPID credentials and other runtime settings. Separately encrypted configuration package; never commit it. |
| Optional Caddy: `./Caddyfile`, `caddy_data` → `/data`, `caddy_config` → `/config` | Proxy configuration, ACME account/certificates/private keys and runtime state. Included when that profile's containers exist. Read-only config mounts must already match when restoring. |
| Custom proxy/files/external services | Inventory separately and pass extra local config files to the backup command. The generic scripts reject external DB/Redis; do not accidentally dump the unused bundled DB or shared databases. |

The backup command resolves the actual Compose configuration and inspects container
mounts, so named-volume and bind-directory choices are recorded. Its logical dump
does not copy the physical PostgreSQL directory. It does not copy the source tree,
`.git`, or an age private identity. Protect temporary files on the backup host with
filesystem permissions/encryption; a failed attempt can leave an incomplete output
directory, which must not be treated as a valid snapshot.

## Built-in backup versus full instance snapshot

| Property | Admin UI `setup` | Admin UI `full` | Raw PG dump / instance snapshot |
| --- | --- | --- | --- |
| Application setup, users/credentials, drafts/scheduled content | Included in classified setup tables | Included | Included |
| Cached folders/messages/unfetchable UIDs | Omitted; resync required | Included | Included |
| Webhook subscriptions, baselines, events and deliveries | All four included | All four included | Included |
| API tokens and short-lived auth flows | Omitted; restore removes them | Omitted; restore removes them | Raw dump includes them; the provided restore script explicitly revokes them |
| `.env`, disk image cache, Redis, TLS/Caddy files | Not included | Not included | Captured in encrypted runtime/config packages by the provided script |
| Matching application/schema | Enforced before any write | Enforced before any write | Operator must select the recorded matched images; script checks their actual config IDs |
| Matching `ENCRYPTION_KEY` | Encrypted key-check enforced | Encrypted key-check enforced | Raw PG has no key check; provided script compares source/target runtime keys |
| Outgoing state on restore | Scheduled mail paused/uncertain as appropriate; Webhooks disabled, leases normalized | Same | Raw `pg_restore` alone does none of this; provided script applies the normalization before backend start |

Admin UI backups are gzip JSON-lines, not encrypted envelopes. Encrypt them before
retention/transfer. Restoring one replaces application data in a transaction and
restarts the backend; it is not a filesystem/configuration restore. Never assume
`setup` contains a complete copy of mail. A Webhook event preserves its original
message-cache UUID even if that cache was omitted or rebuilt, so its `/api/v1`
resource URL can return 404 after a setup restore. Full/raw restore preserves the
snapshot's cache IDs, but later cache removal can still invalidate a URL.

Losing or changing `ENCRYPTION_KEY` makes stored mailbox/OAuth credentials and
Webhook target/signing secrets unreadable. Retain the exact matching key in the
encrypted configuration backup; an age identity is a different key with a different
purpose. Recreate API tokens after restore. Raw SQL restored without the script can
resurrect a token revoked after the restore point, so revoke those tokens before
allowing access.

## Encrypted instance backup

Prerequisites: Bash, Python 3, Docker/Compose, GNU tar, `sha256sum`, and
standard `age` / `age-keygen`. Run from the deployment directory. Put the output
outside the source/build directory and store the private age identity separately.
Generate and protect the identity on the recovery host; only its public recipient
is needed on the normal backup host.

```bash
# On the protected recovery host, not in the source/build context:
umask 077
age-keygen -o /secure/mailflow-age-identity.txt
age-keygen -y /secure/mailflow-age-identity.txt

# On the installation/backup host (replace recipient with that public value):
export MAILFLOW_PROJECT=mailflow-plus
export MAILFLOW_COMPOSE_FILE=docker-compose.plus.yml
export MAILFLOW_ENV_FILE=/secure/mailflow/installation.env
# If used, also set MAILFLOW_COMPOSE_OVERLAY=docker-compose.https.yml
bash scripts/release/backup.sh /backups/mailflow/2026-11-07T120000Z age1PUBLIC_RECIPIENT
```

The command briefly stops frontend/backend, Redis and any existing Caddy container,
then creates one consistent PG custom dump and captures each non-PG runtime mount.
It resumes only the services that were running beforehand, including on failure.
`data.tar.age` and `config.tar.age` are separate encrypted envelopes; `snapshot.json`
records schema/source/image identities without secrets, and `SHA256SUMS` verifies
the encrypted files. Record the backup's exit status and monitor failures.

To exercise byte-for-byte decryption verification during an isolated drill, set
`MAILFLOW_VERIFY_IDENTITY=/secure/mailflow-age-identity.txt` before the backup. A
production backup host with an offline identity should instead transfer the
encrypted files to the recovery host and perform the following checks there:

```bash
cd /backups/mailflow/2026-11-07T120000Z
sha256sum -c SHA256SUMS
age -d -i /secure/mailflow-age-identity.txt data.tar.age | tar -tf - >/dev/null
age -d -i /secure/mailflow-age-identity.txt config.tar.age | tar -tf - >/dev/null
```

Listing a decrypted archive proves decryption/readability; only the isolated
application restore proves a usable recovery point. Never log the decrypted
configuration or pass secrets through shell tracing.

## Restore in isolation

Keep the source installation stopped or otherwise prevent duplicate external
effects. Select a fresh isolated Compose project and dedicated database/Redis.
Block external egress while inspecting recovery; do not attach real mailbox
credentials to a rehearsal. The provided smoke overlay uses a Docker network with
`internal: true` and localhost-only dynamic ports.

Decrypt the configuration package to a private directory first. It contains the
matched `.env`, resolved configuration and original runtime inspections. Restore
the required configuration files on the recovery host without publishing their
contents. Set the recorded image references, load the exact archived app/PG/Redis
images, and create the target containers without starting backend/frontend:

```bash
umask 077
mkdir -p /secure/recovery
age -d -i /secure/mailflow-age-identity.txt \
  /backups/mailflow/2026-11-07T120000Z/config.tar.age \
  | tar -xf - -C /secure/recovery
install -m 600 /secure/recovery/config/installation.env /secure/recovery/installation.env
# Edit this private .env before creating anything:
# - retain the original ENCRYPTION_KEY and matched image references;
# - bind APP_PORT/APP_HTTP_PORT to localhost;
# - remove POSTGRES_DATA/REDIS_DATA host binds so the fresh project gets fresh volumes;
# - use the isolated rehearsal network overlay, never the live proxy/mail network.
export MAILFLOW_PROJECT=mailflow-recovery
export MAILFLOW_ENV_FILE=/secure/recovery/installation.env
export MAILFLOW_COMPOSE_FILE=docker-compose.plus.yml
# Match snapshot image IDs and ENCRYPTION_KEY; keep localhost/isolated networking.
docker compose -p "$MAILFLOW_PROJECT" --env-file "$MAILFLOW_ENV_FILE" \
  -f "$MAILFLOW_COMPOSE_FILE" create --no-build --pull never
MAILFLOW_RESTORE=replace-isolated-instance \
  bash scripts/release/restore.sh /backups/mailflow/2026-11-07T120000Z \
  /secure/mailflow-age-identity.txt
```

The explicit restore selector identifies a data-replacing operation. The script
verifies both encrypted packages, exact image IDs and encryption key, stops writers,
uses single-transaction `pg_restore`, restores runtime mounts, revokes transient/API
tokens, normalizes scheduled mail, and calls the candidate image's existing
Webhook restore normalization. It invalidates the dedicated Redis sessions and
leaves frontend/backend stopped. A failure also leaves them stopped. Do not
consider a partially completed filesystem restore complete; retain the original
snapshot and retry on a fresh target.

The target database must be fresh or have exactly the snapshot schema version.
An old dump does not clean objects unknown to that dump, so this script refuses a
different existing migration version. For a pre-0076 rollback, create fresh
dedicated PostgreSQL storage and restore the old snapshot there; retain the
candidate storage for investigation. Selecting an old application image alone
does not make an upgraded database an appropriate restore target.

Inspect paused queues, current receiver/credentials, mount ownership and recovered
settings before starting the target. Only then run the explicit `up --no-build
--pull never --wait` command. Check application health, fresh login, a known mailbox
credential decryption, expected mail/cache IDs and `/api/v1` with a newly created
token. Check Webhook configuration, pending/failed counts and cleared leases; keep
subscriptions disabled until their receiver and duplicate-event handling are
reviewed. Re-enabling a subscription can resume pending deliveries.

## Upgrade and rollback checklist

1. Select a successful exact-SHA prepare run. Preserve its fixed source, both app
   archives/manifests, PG/Redis image identities, matched configuration and an
   encrypted pre-upgrade snapshot. Verify available disk and a recent successful
   isolated recovery before stopping the current instance.
2. Stop writes and record the restore-point time. Upgrade the complete application
   pair together. Check migration `0076_webhooks`, runtime revision/image IDs,
   healthy frontend/backend/PG/Redis, fresh login, known data/credentials/API, and
   Webhook settings/queue before opening access.
3. If rollback is needed, stop the candidate. Restore the **old matching images,
   old pre-0076 database snapshot and old matching configuration**. Do not point
   the old image at the upgraded schema and call it a rollback. Keep candidate
   snapshot/queue evidence separately if investigation is needed.
4. Verify the old schema and all critical flows again. A snapshot rollback loses
   local changes after the restore point, including new settings, queues, tokens
   and cached state. Messages retained by the remote mail provider may resync,
   but that does not recover local-only state or prove absence of external effects.
5. Record the actual timing, old/new SHA, schema, OCI digest, loaded image IDs and
   restore point. Never use `latest` as the rollback selector.

The isolated CI rehearsal separately tests pre-0076 → candidate upgrade, matched
old-snapshot rollback, candidate full/setup application restore and the generic
Compose backup/restore script roundtrip. Assess that run's logs and result JSON for
actual coverage, timings and failures. PG16/Redis7 is the supported exercise
combination. Historical PG18/Redis8 usage is a deployment clue, not a claim of
compatibility or authorization to change the old server.

## Before a future production deployment

- Select the registry account/repository/visibility if registry distribution is
  wanted; alternatively retain the reviewed offline bundle privately. Registry
  push, release tags/releases and production deploy remain separate actions.
- Select the exact server, domain, HTTPS proxy and maintenance window. With Caddy,
  use `docker-compose.plus.yml` plus the existing `docker-compose.https.yml` and
  `--profile https`; only expose ports 80/443 after DNS/firewall/HTTPS are ready.
  Confirm proxy hops and trusted HTTPS from the intended remote device.
- Protect first registration. The first account becomes admin; registration is
  closed after that first registration in the current code. Verify that state
  and use invitations intentionally before opening access.
- Choose the backup frequency, retention, off-site destination and recovery goals.
  A starting proposal is daily encrypted backups, 14 daily and 8 weekly recovery
  points, one independent off-site copy, and a monthly isolated restore. Adjust
  to volume/RPO/RTO. Configure a scheduler, failure alerts, storage credentials and
  retention deletion only after those targets are chosen. None is already set up
  by this guide or the CI exercise.
- Test the selected Android device's installed PWA and system notifications. The
  previous mobile-browser simulation does not cover a physical Android device,
  installation integration or OS push behavior.
