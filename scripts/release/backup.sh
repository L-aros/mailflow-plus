#!/usr/bin/env bash
# Local Linux Docker daemon; Bash, Python 3, age, tar and sha256sum required.
# Never enable shell tracing: Compose and runtime environment include secrets.
set -euo pipefail
umask 077
if (( $# < 2 )); then
  echo 'Usage: backup.sh OUTPUT_DIRECTORY AGE_RECIPIENT [EXTRA_CONFIG_FILE ...]' >&2
  exit 2
fi
: "${MAILFLOW_ENV_FILE:?Set MAILFLOW_ENV_FILE to the installation .env file}"
compose_file=${MAILFLOW_COMPOSE_FILE:-docker-compose.plus.yml}
project=${MAILFLOW_PROJECT:-mailflow-plus}
output=$1
recipient=$2
shift 2
[[ ! -e $output ]] || { echo 'Output directory must not already exist.' >&2; exit 2; }
[[ -f $MAILFLOW_ENV_FILE && -f $compose_file ]] || exit 2
for executable in docker python3 age tar sha256sum; do command -v "$executable" >/dev/null; done
compose=(docker compose -p "$project" --env-file "$MAILFLOW_ENV_FILE" -f "$compose_file")
if [[ -n ${MAILFLOW_COMPOSE_OVERLAY:-} ]]; then compose+=(-f "$MAILFLOW_COMPOSE_OVERLAY"); fi
stage=$(mktemp -d)
restart=()
cleanup() {
  result=$?
  if (( ${#restart[@]} )); then
    if ! "${compose[@]}" start "${restart[@]}" >/dev/null; then result=1; fi
  fi
  rm -rf -- "$stage"
  exit "$result"
}
trap cleanup EXIT
mkdir -p "$output" "$stage/data/mounts" "$stage/config/extra"
cp -- "$MAILFLOW_ENV_FILE" "$stage/config/installation.env"
"${compose[@]}" config --format json > "$stage/config/compose.resolved.json"
cp -- "$compose_file" "$stage/config/compose.entry.yml"
cp -- docker-compose.yml "$stage/config/compose.base.yml"
if [[ -n ${MAILFLOW_COMPOSE_OVERLAY:-} ]]; then cp -- "$MAILFLOW_COMPOSE_OVERLAY" "$stage/config/compose.overlay.yml"; fi
index=0
for file in "$@"; do
  [[ -f $file ]] || { echo 'An extra configuration file does not exist.' >&2; exit 2; }
  cp -- "$file" "$stage/config/extra/$index-$(basename "$file")"
  ((index+=1))
done

postgres=$("${compose[@]}" ps -aq postgres)
[[ -n $postgres ]] || { echo 'The bundled postgres container must exist.' >&2; exit 2; }
docker inspect "$postgres" > "$stage/config/postgres.inspect.json"
# The generic script intentionally supports the bundled DB only. An external/shared
# DB requires a separately scoped dump, not a dump of this unused bundled service.
backend=$("${compose[@]}" ps -aq backend)
[[ -n $backend ]] || exit 2
docker inspect "$backend" > "$stage/config/backend.inspect.json"
python3 - "$stage/config/backend.inspect.json" <<'PY'
import json, sys
env = dict(x.split('=', 1) for x in json.load(open(sys.argv[1]))[0]['Config']['Env'])
if env.get('DB_HOST', 'postgres') != 'postgres' or env.get('REDIS_URL', '') != 'redis://redis:6379':
    raise SystemExit('This script supports bundled postgres/redis only; scope external service backups separately.')
if not env.get('ENCRYPTION_KEY'):
    raise SystemExit('A persistent ENCRYPTION_KEY must be configured before backup.')
PY

# Stop all application writers before the PG snapshot and runtime-file copy.
# Record only services that were running so cleanup does not enable a profile.
printf '[]' > "$stage/data/mounts.json"
for service in frontend backend redis caddy; do
  cid=$("${compose[@]}" ps -aq "$service")
  [[ -n $cid ]] || continue
  docker inspect "$cid" > "$stage/config/$service.inspect.json"
  if [[ $(docker inspect --format '{{.State.Running}}' "$cid") == true ]]; then
    restart+=("$service")
  fi
done
if (( ${#restart[@]} )); then "${compose[@]}" stop "${restart[@]}" >/dev/null; fi
docker exec "$postgres" sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' > "$stage/data/database.dump"
docker exec "$postgres" sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT MAX(version) FROM schema_migrations"' > "$stage/data/schema-version.txt"

index=0
for service in frontend backend redis caddy; do
  file="$stage/config/$service.inspect.json"
  [[ -f $file ]] || continue
  python3 - "$file" "$service" <<'PY' > "$stage/mount-plan.tsv"
import json, sys
container = json.load(open(sys.argv[1]))[0]
for mount in container['Mounts']:
    # docker cp follows the container mount, so named volumes and bind mounts
    # are captured without guessing host paths. PG's physical data is not copied.
    if '\t' in mount['Destination'] or '\n' in mount['Destination']:
        raise SystemExit('Unsupported mount path.')
    print(container['Id'], mount['Destination'], mount['Type'], str(not mount['RW']).lower(), sep='\t')
PY
  while IFS=$'\t' read -r cid destination mount_type readonly; do
    # Stream Docker's archive instead of unpacking to a host-owned directory:
    # unpacking as the CI/backup user would silently change numeric UID/GID.
    docker cp "$cid:$destination" - > "$stage/data/mounts/$index.tar"
    kind=$(python3 - "$stage/data/mounts/$index.tar" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    root = archive.next()
    if root is None: raise SystemExit('Empty mount archive.')
    print('directory' if root.isdir() else 'file')
PY
)
    python3 - "$stage/data/mounts.json" "$index" "$service" "$destination" "$kind" "$mount_type" "$readonly" <<'PY'
import json, sys
path, index, service, destination, kind, mount_type, readonly = sys.argv[1:]
rows = json.load(open(path))
rows.append(dict(index=int(index), service=service, destination=destination, kind=kind, mountType=mount_type, readOnly=readonly == 'true'))
with open(path, 'w') as out: json.dump(rows, out, indent=2)
PY
    ((index+=1))
  done < "$stage/mount-plan.tsv"
done
python3 - "$stage/config" "$stage/data/schema-version.txt" "$output/snapshot.json" <<'PY'
import json, pathlib, sys
config, schema, output = map(pathlib.Path, sys.argv[1:])
images = {}
for service in ('frontend', 'backend', 'postgres', 'redis', 'caddy'):
    path = config / f'{service}.inspect.json'
    if not path.exists(): continue
    item = json.load(path.open())[0]
    images[service] = {'reference': item['Config']['Image'], 'imageConfigId': item['Image'],
                       'sourceRevision': (item['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')}
json.dump({'format': 1, 'kind': 'quiesced-pg-custom-and-runtime-mounts', 'schemaVersion': schema.read_text().strip(),
           'images': images, 'registryManifestDigests': 'not inferred from image config IDs'}, output.open('w'), indent=2)
PY
# Encrypt data and configuration separately. Identity/private keys are never copied.
for part in data config; do
  tar -C "$stage" -cf "$stage/$part.tar" "$part"
  age -r "$recipient" -o "$output/$part.tar.age" "$stage/$part.tar"
  # Optional online verification. For offline-held identities, run the documented
  # decrypt/hash verification on the separate recovery host before retention expiry.
  if [[ -n ${MAILFLOW_VERIFY_IDENTITY:-} ]]; then
    expected=$(sha256sum "$stage/$part.tar" | cut -d ' ' -f 1)
    actual=$(age -d -i "$MAILFLOW_VERIFY_IDENTITY" "$output/$part.tar.age" | sha256sum | cut -d ' ' -f 1)
    [[ $expected == "$actual" ]] || { echo 'Decryption verification failed.' >&2; exit 1; }
  fi
done
(cd "$output" && sha256sum data.tar.age config.tar.age snapshot.json > SHA256SUMS)
echo 'Created encrypted snapshot; application services are being resumed.'
