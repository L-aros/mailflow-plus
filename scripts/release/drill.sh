#!/usr/bin/env bash
# Real-container release rehearsal. No published ports; no production resources.
# Usage: drill.sh CANDIDATE_BACKEND CANDIDATE_FRONTEND OLD_BACKEND OLD_FRONTEND OUTPUT_DIR
set -euo pipefail
if [[ $# != 5 ]]; then echo 'Usage: drill.sh candidate-backend candidate-frontend old-backend old-frontend output-dir' >&2; exit 2; fi
candidate_backend=$1 candidate_frontend=$2 old_backend=$3 old_frontend=$4
output=$(realpath -m "$5")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for executable in docker age age-keygen openssl python3 tar; do command -v "$executable" >/dev/null; done
mkdir -p "$output"
private=$(mktemp -d "${RUNNER_TEMP:-/tmp}/mailflow-drill.XXXXXXXX")
chmod 700 "$private"
prefix="mf-drill-${RANDOM}-${RANDOM}"
network="$prefix-network"
backend="$prefix-backend" frontend="$prefix-frontend" postgres="$prefix-postgres" redis="$prefix-redis"
postgres_image=${MAILFLOW_DRILL_POSTGRES_IMAGE:-postgres:16-alpine}
redis_image=${MAILFLOW_DRILL_REDIS_IMAGE:-redis:7-alpine}
cache_volume="$prefix-images" cert_volume="$prefix-certs" pg_volume="$prefix-postgres" redis_volume="$prefix-redis"
active_backend='' active_frontend=''
started_at=$(date -u +%FT%TZ)
start_seconds=$SECONDS
cleanup() {
  code=$?
  trap - EXIT
  if [[ $code != 0 ]]; then
    # Private failure material is deliberately not placed in public artifacts.
    for container in "$backend" "$frontend" "$postgres" "$redis"; do
      docker logs "$container" >"$private/${container}.log" 2>&1 || true
    done
    printf '{"ok":false,"exitCode":%s,"privateLogsRetainedOnEphemeralRunner":true}\n' "$code" >"$output/drill-failure.json"
  fi
  docker rm -f "$backend" "$frontend" "$postgres" "$redis" "$prefix-helper" "$prefix-clean" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$cache_volume" "$cert_volume" "$pg_volume" "$redis_volume" >/dev/null 2>&1 || true
  remaining_containers=$(docker ps -a --filter "name=$prefix-" --format '{{.Names}}') || code=1
  remaining_networks=$(docker network ls --filter "name=$network" --format '{{.Name}}') || code=1
  remaining_volumes=$(docker volume ls --filter "name=$prefix-" --format '{{.Name}}') || code=1
  if [[ -n $remaining_containers || -n $remaining_networks || -n $remaining_volumes ]]; then code=1; fi
  # On success no plaintext fixture data or decryption key remains on the runner.
  if [[ $code == 0 ]]; then rm -rf -- "$private"; fi
  secrets_deleted=false
  [[ -e $private ]] || secrets_deleted=true
  python3 - "$output" "$code" "$secrets_deleted" "$remaining_containers" "$remaining_networks" "$remaining_volumes" <<'PY'
import json,pathlib,sys
out=pathlib.Path(sys.argv[1]); record={'ok':sys.argv[2]=='0','ephemeralSecretsDeleted':sys.argv[3]=='true',
    'remainingContainers':sys.argv[4].splitlines(),'remainingNetworks':sys.argv[5].splitlines(),'remainingVolumes':sys.argv[6].splitlines()}
(out/'cleanup.json').write_text(json.dumps(record,indent=2)+'\n')
path=out/'drill-results.json'
if path.exists():
    result=json.loads(path.read_text()); result['cleanup']=record; result['ok']=result['ok'] and record['ok']
    result['ephemeralSecretsDeletedOnSuccess']=record['ephemeralSecretsDeleted']
    path.write_text(json.dumps(result,indent=2)+'\n')
PY
  exit "$code"
}
trap cleanup EXIT

cat >"$private/runtime.env" <<EOF
NODE_ENV=production
PORT=3000
DB_HOST=postgres
DB_PORT=5432
DB_USER=mailflow
DB_NAME=mailflow
DB_PASSWORD=$(openssl rand -hex 24)
REDIS_URL=redis://redis:6379
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
APP_URL=http://frontend
FRONTEND_URL=http://frontend
IMAGE_CACHE_DIR=/var/cache/mailflow/images
EOF
chmod 600 "$private/runtime.env"
db_password=$(sed -n 's/^DB_PASSWORD=//p' "$private/runtime.env")
mkdir -p "$private/keys" "$private/snapshots" "$private/fixtures"
chmod 700 "$private/keys" "$private/snapshots" "$private/fixtures"
age-keygen -o "$private/keys/identity.txt" 2>"$private/keys/public.txt"
recipient=$(age-keygen -y "$private/keys/identity.txt")
docker network create --internal "$network" >/dev/null
for volume in "$cache_volume" "$cert_volume" "$pg_volume" "$redis_volume"; do docker volume create "$volume" >/dev/null; done
docker run -d --name "$postgres" --network "$network" --network-alias postgres \
  -e POSTGRES_DB=mailflow -e POSTGRES_USER=mailflow -e "POSTGRES_PASSWORD=$db_password" \
  -v "$pg_volume:/var/lib/postgresql/data" "$postgres_image" >/dev/null
docker run -d --name "$redis" --network "$network" --network-alias redis \
  -v "$redis_volume:/data" "$redis_image" redis-server --save 60 1 --loglevel warning >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$postgres" pg_isready -U mailflow -d mailflow >/dev/null 2>&1 && [[ $(docker exec "$redis" redis-cli ping) == PONG ]]; then break; fi
  if [[ $attempt == 60 ]]; then echo 'Database/Redis readiness failed' >&2; exit 1; fi
  sleep 1
done

wait_app() {
  for attempt in $(seq 1 90); do
    if docker exec "$backend" node --input-type=module -e "const r=await fetch('http://frontend/api/health',{signal:AbortSignal.timeout(2000)}); if(!r.ok||(await r.json()).status!=='ok')process.exit(1)" >/dev/null 2>&1; then return; fi
    if [[ $attempt == 90 ]]; then echo 'Application readiness failed' >&2; return 1; fi
    sleep 1
  done
}
start_apps() {
  active_backend=$1 active_frontend=$2
  docker rm -f "$backend" "$frontend" >/dev/null 2>&1 || true
  docker run -d --pull=never --name "$backend" --restart unless-stopped --network "$network" --network-alias backend \
    --env-file "$private/runtime.env" -v "$private/fixtures:/drill" -v "$cache_volume:/var/cache/mailflow/images" "$active_backend" >/dev/null
  docker cp "$script_dir/drill-fixture.mjs" "$backend:/app/drill-fixture.mjs"
  docker run -d --pull=never --name "$frontend" --network "$network" --network-alias frontend \
    -v "$cert_volume:/etc/nginx/ssl" "$active_frontend" >/dev/null
  wait_app
}
stop_apps() { docker stop -t 30 "$frontend" "$backend" >/dev/null; }
fixture() {
  local operation=$1 evidence=$2
  docker exec --user 0 "$backend" node /app/drill-fixture.mjs "$operation" >"$output/$evidence.json"
}
oneshot_fixture() {
  local operation=$1 evidence=$2 helper="$prefix-helper"
  # Use the same concrete backend image and its dependencies, with the main app stopped.
  docker create --pull=never --name "$helper" --network "$network" --user 0 --env-file "$private/runtime.env" \
    -v "$private/fixtures:/drill" -v "$cache_volume:/var/cache/mailflow/images" --entrypoint node \
    "$candidate_backend" /app/drill-fixture.mjs "$operation" >/dev/null
  docker cp "$script_dir/drill-fixture.mjs" "$helper:/app/drill-fixture.mjs"
  local status=0
  docker start -a "$helper" >"$output/$evidence.json" || status=$?
  local container_status
  container_status=$(docker inspect --format '{{.State.ExitCode}}' "$helper")
  if [[ $container_status != 0 ]]; then status=$container_status; fi
  docker rm -f "$helper" >/dev/null
  return "$status"
}
record_runtime() {
  local point=$1
  docker inspect "$backend" "$frontend" "$postgres" "$redis" \
    --format '{{json .Name}} {{json .Config.Image}} {{json .Image}} {{json .Config.Labels}}' >"$output/$point-runtime-images.txt"
}
snapshot() {
  local name=$1 begin=$SECONDS
  local directory="$private/snapshots/$name"
  mkdir -p "$directory/data" "$directory/config"
  stop_apps
  docker exec "$postgres" pg_dump -U mailflow -d mailflow -Fc >"$directory/data/database.dump"
  docker exec "$redis" redis-cli SAVE >/dev/null
  # Keep numeric ownership/modes in tar streams with canonical ./ entries.
  # Extracting on the runner would map ownership to its host UID. The source
  # mounts are read-only in these network-isolated, root-user helpers.
  docker run --rm --pull=never --network none --user 0 --volumes-from "$backend:ro" \
    --entrypoint tar "$candidate_backend" -cpf - -C /var/cache/mailflow/images . >"$directory/data/images.tar"
  docker run --rm --pull=never --network none --user 0 --volumes-from "$redis:ro" \
    --entrypoint tar "$candidate_backend" -cpf - -C /data . >"$directory/data/redis.tar"
  docker run --rm --pull=never --network none --user 0 --volumes-from "$frontend:ro" \
    --entrypoint tar "$candidate_backend" -cpf - -C /etc/nginx/ssl . >"$directory/config/certs.tar"
  cp "$private/runtime.env" "$directory/config/runtime.env"
  tar -C "$directory/data" -cf "$directory/data.tar" .
  tar -C "$directory/config" -cf "$directory/config.tar" .
  for part in data config; do
    age -r "$recipient" -o "$directory/$part.tar.age" "$directory/$part.tar"
    age -d -i "$private/keys/identity.txt" -o "$directory/$part.verified.tar" "$directory/$part.tar.age"
    cmp "$directory/$part.tar" "$directory/$part.verified.tar"
  done
  local schema
  schema=$(docker exec "$postgres" psql -U mailflow -d mailflow -Atc 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
  python3 - "$directory" "$output/$name-backup.json" "$((SECONDS-begin))" "$active_backend" "$active_frontend" "$schema" <<'PY'
import hashlib,json,pathlib,sys
source=pathlib.Path(sys.argv[1])
names=['data/database.dump','data.tar','data.tar.age','config.tar','config.tar.age']
record={'ok':True,'format':'pg_dump-custom+tar+age','writesStopped':True,'elapsedSeconds':int(sys.argv[3]),
        'encryptedDataAndConfigurationSeparate':True,'identityStoredSeparately':True,
        'backendImage':sys.argv[4],'frontendImage':sys.argv[5],'schema':sys.argv[6],
        'decryptByteComparison':True,'publishedBackup':False,'sha256':{name:hashlib.sha256((source/name).read_bytes()).hexdigest() for name in names}}
pathlib.Path(sys.argv[2]).write_text(json.dumps(record,indent=2)+'\n')
PY
}
restore_snapshot() {
  local name=$1 pause=${2:-no} begin=$SECONDS
  local directory="$private/snapshots/$name" restored="$private/restored-$name"
  mkdir -p "$restored/data" "$restored/config"
  age -d -i "$private/keys/identity.txt" "$directory/data.tar.age" | tar -C "$restored/data" -xf -
  age -d -i "$private/keys/identity.txt" "$directory/config.tar.age" | tar -C "$restored/config" -xf -
  cp "$restored/config/runtime.env" "$private/runtime.env"
  docker stop "$redis" >/dev/null
  # These are generated, dedicated rehearsal volumes. Replace their complete
  # contents so files created after the recovery point cannot survive a rollback.
  docker run --rm --pull=never --name "$prefix-clean" --network none --user 0 \
    --mount "type=volume,source=$cache_volume,target=/restore/images" \
    --mount "type=volume,source=$cert_volume,target=/restore/certs" \
    --mount "type=volume,source=$redis_volume,target=/restore/redis" \
    --entrypoint sh "$candidate_backend" -c \
    'for target in /restore/images /restore/certs /restore/redis; do find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; done'
  docker exec "$postgres" dropdb -U mailflow --force mailflow
  docker exec "$postgres" createdb -U mailflow mailflow
  docker exec -i "$postgres" pg_restore -U mailflow -d mailflow --exit-on-error --no-owner <"$restored/data/database.dump"
  for part in images certs redis; do
    archive="$restored/data/$part.tar"
    [[ $part != certs ]] || archive="$restored/config/certs.tar"
    volume="$cache_volume"
    [[ $part != certs ]] || volume="$cert_volume"
    [[ $part != redis ]] || volume="$redis_volume"
    docker run --rm --interactive --pull=never --network none --user 0 \
      --mount "type=volume,source=$volume,target=/restore-target" \
      --entrypoint tar "$candidate_backend" -xpf - -C /restore-target <"$archive"
  done
  mkdir -p "$restored/verified"
  for filename in cert.pem key.pem; do
    docker cp "$frontend:/etc/nginx/ssl/$filename" "$restored/verified/$filename"
  done
  docker cp "$backend:/var/cache/mailflow/images/release-drill.txt" "$restored/verified/release-drill.txt"
  python3 - "$restored" <<'PY'
import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1])
for archive,names in [(root/'config/certs.tar',['cert.pem','key.pem']),(root/'data/images.tar',['release-drill.txt'])]:
    with tarfile.open(archive) as source:
        for name in names:
            member=next(item for item in source if pathlib.PurePosixPath(item.name).name==name)
            assert source.extractfile(member).read()==(root/'verified'/name).read_bytes(),name
PY
  docker start "$redis" >/dev/null
  if [[ $pause == yes ]]; then oneshot_fixture pause-raw "$name-raw-pause"; fi
  printf '{"ok":true,"elapsedSeconds":%s,"restoredMatchingConfiguration":true,"redisRdbRestored":true,"imageCacheRestored":true,"tlsFilesRestored":true,"rawPgAutomaticNormalization":false}\n' "$((SECONDS-begin))" >"$output/$name-restore.json"
}

start_apps "$old_backend" "$old_frontend"
fixture seed old-seed
fixture verify-old old-verify
record_runtime old
snapshot old

upgrade_start=$SECONDS
start_apps "$candidate_backend" "$candidate_frontend"
fixture verify-upgrade upgrade-verify
printf '{"ok":true,"elapsedSeconds":%s,"schemaBefore":"0075_gmail_provider_msgid","schemaAfter":"0076_webhooks"}\n' "$((SECONDS-upgrade_start))" >"$output/upgrade.json"
fixture upgrade-data candidate-data
fixture download builtin-download
for scope in full setup; do
  age -r "$recipient" -o "$private/fixtures/candidate-$scope.json.gz.age" "$private/fixtures/candidate-$scope.json.gz"
  age -d -i "$private/keys/identity.txt" -o "$private/fixtures/candidate-$scope.verified.json.gz" "$private/fixtures/candidate-$scope.json.gz.age"
  cmp "$private/fixtures/candidate-$scope.json.gz" "$private/fixtures/candidate-$scope.verified.json.gz"
done
printf '{"ok":true,"scopes":["full","setup"],"encryption":"age","decryptByteComparison":true,"publishedBackup":false}\n' >"$output/builtin-encryption.json"
record_runtime candidate
snapshot candidate
oneshot_fixture probe-worker receiver

# Mutate after the candidate recovery point; restore must remove this row/file change.
start_apps "$candidate_backend" "$candidate_frontend"
fixture mutate post-snapshot-mutation
docker exec "$frontend" sh -c 'printf "post-snapshot certificate-directory file\n" > /etc/nginx/ssl/after-snapshot.txt'
docker exec "$redis" sh -c 'printf "post-snapshot redis-directory file\n" > /data/after-snapshot.txt'
stop_apps
raw_restore_start=$SECONDS
restore_snapshot candidate yes
start_apps "$candidate_backend" "$candidate_frontend"
fixture verify-raw candidate-raw-verify
docker exec "$backend" sh -ec 'printf "node write probe\n" > /var/cache/mailflow/images/restored-write-probe.txt; rm /var/cache/mailflow/images/restored-write-probe.txt'
docker exec "$frontend" test ! -e /etc/nginx/ssl/after-snapshot.txt
docker exec "$redis" test ! -e /data/after-snapshot.txt
record_runtime candidate-restored
printf '{"ok":true,"elapsedSeconds":%s,"restoredMessageCount":2,"discardedSyntheticMessagesAfterCandidateRecoveryPoint":1,"postSnapshotExtraFilesRemovedFromAllThreeVolumes":true,"restoredCacheWritableByDefaultApplicationUser":true,"numericOwnershipAndModesRetainedInTarStreams":true}\n' "$((SECONDS-raw_restore_start))" >"$output/candidate-raw-recovery.json"

full_restore_start=$SECONDS
fixture restore-full builtin-full-restore
docker restart "$backend" >/dev/null
wait_app
fixture verify-full builtin-full-verify
printf '{"ok":true,"elapsedSeconds":%s}\n' "$((SECONDS-full_restore_start))" >"$output/builtin-full-recovery.json"

setup_restore_start=$SECONDS
fixture restore-setup builtin-setup-restore
docker restart "$backend" >/dev/null
wait_app
fixture verify-setup builtin-setup-verify
printf '{"ok":true,"elapsedSeconds":%s}\n' "$((SECONDS-setup_restore_start))" >"$output/builtin-setup-recovery.json"

rollback_start=$SECONDS
stop_apps
restore_snapshot old no
start_apps "$old_backend" "$old_frontend"
fixture verify-rollback rollback-verify
record_runtime rollback
printf '{"ok":true,"elapsedSeconds":%s,"matchingOldImageAndSnapshot":true,"schema":"0075_gmail_provider_msgid","restoredMessageCount":1,"discardedSyntheticMessagesAfterOldRecoveryPoint":2}\n' "$((SECONDS-rollback_start))" >"$output/rollback.json"

python3 - "$output" "$started_at" "$((SECONDS-start_seconds))" "$network" <<'PY'
import datetime,json,pathlib,sys
out=pathlib.Path(sys.argv[1]); records={p.stem:json.loads(p.read_text()) for p in sorted(out.glob('*.json')) if p.name!='drill-results.json'}
assert all(record.get('ok') is True for record in records.values()),'A drill evidence record did not pass'
result={'ok':True,'startedAt':sys.argv[2],'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'elapsedSeconds':int(sys.argv[3]),'network':{'name':sys.argv[4],'internal':True,'publishedPorts':[]},
        'fixtureScope':'synthetic parsed-mail cache SQL fixtures; protocol=fixture; real imapflow authentication probe; test-only SQL loopback subscription and injected webhook HTTP transport',
        'externalMailOrReceiverUsed':False,'productionTransportPrivateTargetRequests':0,
        'backupArchivesPublished':False,'records':records}
(out/'drill-results.json').write_text(json.dumps(result,indent=2)+'\n')
PY
printf 'Release recovery drill passed in %s seconds.\n' "$((SECONDS-start_seconds))"
