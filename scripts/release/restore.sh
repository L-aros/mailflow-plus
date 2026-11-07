#!/usr/bin/env bash
# Restore a quiesced backup only to an explicitly selected, isolated installation.
# This intentionally leaves frontend/backend stopped until inspection is complete.
set -euo pipefail
umask 077
[[ $# == 2 ]] || { echo 'Usage: restore.sh SNAPSHOT_DIRECTORY AGE_IDENTITY_FILE' >&2; exit 2; }
[[ ${MAILFLOW_RESTORE:-} == replace-isolated-instance ]] || {
  echo 'Set MAILFLOW_RESTORE=replace-isolated-instance after selecting the isolated target project and .env.' >&2
  exit 2
}
: "${MAILFLOW_ENV_FILE:?Set MAILFLOW_ENV_FILE to the target installation .env}"
compose_file=${MAILFLOW_COMPOSE_FILE:-docker-compose.plus.yml}
project=${MAILFLOW_PROJECT:-mailflow-plus}
snapshot=$(cd "$1" && pwd)
identity=$2
compose=(docker compose -p "$project" --env-file "$MAILFLOW_ENV_FILE" -f "$compose_file")
if [[ -n ${MAILFLOW_COMPOSE_OVERLAY:-} ]]; then compose+=(-f "$MAILFLOW_COMPOSE_OVERLAY"); fi
for executable in docker python3 age tar sha256sum; do command -v "$executable" >/dev/null; done
(cd "$snapshot" && sha256sum -c SHA256SUMS)
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
for part in data config; do
  age -d -i "$identity" -o "$stage/$part.tar" "$snapshot/$part.tar.age"
  python3 - "$stage/$part.tar" "$part" <<'PY'
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or path.parts[0] != sys.argv[2]:
            raise SystemExit('Unsafe path in snapshot.')
        if member.isdev() or member.isfifo(): raise SystemExit('Unsupported snapshot entry.')
        if member.issym() or member.islnk():
            link = pathlib.PurePosixPath(member.linkname)
            if link.is_absolute() or '..' in link.parts: raise SystemExit('Unsafe snapshot link.')
PY
  tar -C "$stage" -xf "$stage/$part.tar"
done
# Existing containers are required: the operator first loads the matched images
# and creates the selected target with the saved, separately decrypted configuration.
for service in backend frontend postgres redis; do
  cid=$("${compose[@]}" ps -aq "$service")
  [[ -n $cid ]] || { echo 'Create the isolated target containers before restoring (see release guide).' >&2; exit 2; }
  docker inspect "$cid" > "$stage/$service.target.json"
done
python3 - "$snapshot/snapshot.json" "$stage" <<'PY'
import json, pathlib, sys
snapshot = json.load(open(sys.argv[1]))
stage = pathlib.Path(sys.argv[2])
if snapshot['format'] != 1: raise SystemExit('Unsupported snapshot format.')
for service in ('frontend', 'backend', 'postgres', 'redis'):
    target = json.load((stage / f'{service}.target.json').open())[0]
    if target['Image'] != snapshot['images'][service]['imageConfigId']:
        raise SystemExit(f'{service}: load and select the exact snapshot image before restoring.')
def environment(item): return dict(x.split('=', 1) for x in item['Config']['Env'])
source_env = environment(json.load((stage / 'config/backend.inspect.json').open())[0])
target_env = environment(json.load((stage / 'backend.target.json').open())[0])
if not source_env.get('ENCRYPTION_KEY') or source_env['ENCRYPTION_KEY'] != target_env.get('ENCRYPTION_KEY'):
    raise SystemExit('The target must use the backup installation ENCRYPTION_KEY.')
if target_env.get('DB_HOST', 'postgres') != 'postgres' or target_env.get('REDIS_URL', '') != 'redis://redis:6379':
    raise SystemExit('Only bundled postgres/redis are supported by this script.')
for mount in json.load((stage / 'data/mounts.json').open()):
    if mount['service'] not in ('frontend', 'backend', 'redis', 'caddy'):
        raise SystemExit('Unsupported mount service.')
    destination = mount['destination']
    if destination in ('', '/') or not destination.startswith('/') or '..' in pathlib.PurePosixPath(destination).parts:
        raise SystemExit('Unsafe mount destination.')
PY
services=()
for service in frontend backend redis caddy; do
  cid=$("${compose[@]}" ps -aq "$service")
  [[ -z $cid ]] || services+=("$service")
done
if (( ${#services[@]} )); then "${compose[@]}" stop "${services[@]}" >/dev/null; fi
"${compose[@]}" start postgres >/dev/null
postgres=$("${compose[@]}" ps -aq postgres)
for attempt in {1..60}; do
  if docker exec "$postgres" sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null; then break; fi
  (( attempt < 60 )) || { echo 'PostgreSQL did not become ready.' >&2; exit 1; }
  sleep 1
done
current_schema=$(docker exec "$postgres" sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT to_regclass('\''public.schema_migrations'\'')"')
if [[ -n $current_schema ]]; then
  current_schema=$(docker exec "$postgres" sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT MAX(version) FROM schema_migrations"')
  [[ $current_schema == "$(cat "$stage/data/schema-version.txt")" ]] || {
    echo 'Target schema differs from the snapshot. Use fresh dedicated PostgreSQL storage, not the upgraded database, for rollback.' >&2
    exit 2
  }
fi
docker exec -i "$postgres" sh -ec 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --exit-on-error --single-transaction --no-owner --no-acl' < "$stage/data/database.dump"
python3 - "$stage/data/mounts.json" <<'PY' > "$stage/restore-plan.tsv"
import json, sys
for mount in json.load(open(sys.argv[1])):
    print(mount['index'], mount['service'], mount['destination'], mount['kind'], str(mount['readOnly']).lower(), sep='\t')
PY
helper_image=$(docker inspect --format '{{.Image}}' "$postgres")
while IFS=$'\t' read -r index service destination kind readonly; do
  cid=$("${compose[@]}" ps -aq "$service")
  [[ -n $cid ]] || { echo 'A captured service/mount is absent from the target.' >&2; exit 1; }
  docker inspect "$cid" > "$stage/mount-target.json"
  python3 - "$stage/mount-target.json" "$destination" "$readonly" <<'PY'
import json, sys
mounts = json.load(open(sys.argv[1]))[0]['Mounts']
if not any(m['Destination'] == sys.argv[2] and (not m['RW']) == (sys.argv[3] == 'true') for m in mounts):
    raise SystemExit('Target mount does not match the snapshot; no mount files were replaced.')
PY
  if [[ $readonly == true ]]; then
    docker cp "$cid:$destination" - > "$stage/readonly-$index.tar"
    python3 - "$stage/data/mounts/$index.tar" "$stage/readonly-$index.tar" <<'PY'
import hashlib, sys, tarfile
def contents(path):
    result = {}
    with tarfile.open(path) as archive:
        for item in archive:
            digest = hashlib.sha256(archive.extractfile(item).read()).hexdigest() if item.isfile() else None
            result[item.name] = (item.type.decode(), item.linkname, digest)
    return result
if contents(sys.argv[1]) != contents(sys.argv[2]):
    raise SystemExit('Restore captured read-only configuration on the target host before retrying.')
PY
    continue
  fi
  docker run --rm --network none --volumes-from "$cid" \
    --entrypoint sh "$helper_image" -ec '
      target=$1
      if [ "$2" = directory ]; then
        find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      fi
    ' sh "$destination" "$kind"
  # Docker's archive extraction with -a preserves the saved numeric UID/GID,
  # independent of the backup host account or the helper image's passwd entries.
  docker cp -a - "$cid:$(dirname "$destination")" < "$stage/data/mounts/$index.tar"
done < "$stage/restore-plan.tsv"
# Raw pg_restore alone does not pause outgoing work or revoke restored tokens.
# Apply those rules before starting the backend, using the actual candidate image.
"${compose[@]}" run --rm -T --no-deps --entrypoint node backend --input-type=module - <<'JS'
import { pool } from './src/services/db.js';
import * as backup from './src/services/backup.js';
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const tables = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r => r.table_name));
  for (const name of ['api_tokens', 'email_otp_tokens', 'password_reset_tokens', 'ai_codex_device_flows']) {
    if (tables.has(name)) await client.query(`TRUNCATE "${name}"`);
  }
  if (tables.has('webhook_subscriptions')) {
    if (!backup.pauseRestoredWebhooks) throw new Error('Matching image lacks Webhook restore normalization.');
    await backup.pauseRestoredWebhooks(client);
  }
  if (tables.has('scheduled_messages')) {
    const released = 'claim_token=NULL, claimed_at=NULL, edit_token=NULL, edit_lease_until=NULL, updated_at=NOW()';
    await client.query(`UPDATE scheduled_messages SET status=status_before, status_before=NULL, ${released} WHERE status='editing' AND status_before IN ('uncertain','failed')`);
    await client.query(`UPDATE scheduled_messages SET ${released} WHERE status='sending' AND smtp_accepted_at IS NOT NULL`);
    await client.query(`UPDATE scheduled_messages SET status='uncertain', ${released} WHERE status='sending' AND smtp_started_at IS NOT NULL AND smtp_accepted_at IS NULL`);
    await client.query(`UPDATE scheduled_messages SET status='paused', pause_reason='restored', status_before=NULL, ${released} WHERE status IN ('scheduled','editing') OR (status='sending' AND smtp_accepted_at IS NULL)`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
JS
"${compose[@]}" start redis >/dev/null
for attempt in {1..30}; do
  if [[ $("${compose[@]}" exec -T redis redis-cli ping 2>/dev/null || true) == PONG ]]; then break; fi
  (( attempt < 30 )) || { echo 'Restored Redis did not become ready.' >&2; exit 1; }
  sleep 1
done
# Restored Redis holds old authenticated sessions; clear just this dedicated
# instance, never a shared/external Redis. The target starts with fresh sessions.
flush_result=$("${compose[@]}" exec -T redis redis-cli -e FLUSHALL)
[[ $flush_result == OK ]] || { echo 'Restored Redis session invalidation did not return OK.' >&2; exit 1; }
echo 'Restored snapshot and paused outgoing work. Frontend/backend remain stopped; inspect and start them explicitly.'
