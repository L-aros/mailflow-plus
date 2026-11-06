#!/usr/bin/env bash
# Run only on an isolated CI Docker runner. All accounts and data are synthetic.
set -euo pipefail
umask 077
[[ $# == 3 ]] || { echo 'Usage: backup-smoke.sh BACKEND_IMAGE FRONTEND_IMAGE PUBLIC_OUTPUT_DIR' >&2; exit 2; }
backend_image=$1
frontend_image=$2
mkdir -p "$3"
public_output=$(cd "$3" && pwd)
stage=$(mktemp -d)
export MAILFLOW_PROJECT="mf-backup-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
export MAILFLOW_COMPOSE_FILE=docker-compose.plus.yml
export MAILFLOW_COMPOSE_OVERLAY="$stage/isolation.yml"
export MAILFLOW_ENV_FILE="$stage/installation.env"
compose=(docker compose -p "$MAILFLOW_PROJECT" --env-file "$MAILFLOW_ENV_FILE" -f "$MAILFLOW_COMPOSE_FILE" -f "$MAILFLOW_COMPOSE_OVERLAY")
started=$(date +%s)
last_step=initialization
cleanup() {
  result=$?
  # Only this CI project's disposable volumes are removed.
  cleanup_code=0
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || cleanup_code=$?
  if (( cleanup_code != 0 )); then result=$cleanup_code; last_step=cleanup-failed; fi
  python3 - "$public_output/backup-smoke.json" "$started" "$result" "$last_step" <<'PY'
import json, sys, time
path, start, result, last_step = sys.argv[1:]
json.dump({'suite': 'generic-compose-backup-restore', 'ok': int(result)==0, 'exitCode': int(result),
           'elapsedSeconds': int(time.time())-int(start), 'lastStep': last_step,
           'checks': ['compose-plus-no-official-image-fallback', 'actual-images-health', 'synthetic-user-login',
                      'age-encrypt-decrypt-byte-verification', 'pg-dump-restore-marker', 'persistent-file-restored',
                      'restored-user-login', 'services-and-volumes-cleaned'],
           'coverage': 'checks are successful only when exitCode=0; failed run is not coverage',
           'secretsAndBackupUploaded': False}, open(path, 'w'), indent=2)
PY
  rm -rf -- "$stage"
  exit "$result"
}
trap cleanup EXIT
python3 - "$MAILFLOW_ENV_FILE" "$backend_image" "$frontend_image" "$stage" <<'PY'
import pathlib, secrets, sys
path, backend, frontend, stage = sys.argv[1:]
values = {'MAILFLOW_BACKEND_IMAGE': backend, 'MAILFLOW_FRONTEND_IMAGE': frontend,
          'SESSION_SECRET': secrets.token_hex(32), 'ENCRYPTION_KEY': secrets.token_hex(32),
          'DB_PASSWORD': secrets.token_hex(16), 'APP_HTTP_PORT': '127.0.0.1:0',
          'APP_PORT': '127.0.0.1:0', 'NGINX_TLS': 'off', 'APP_URL': 'http://localhost'}
pathlib.Path(path).write_text(''.join(f'{key}={value}\n' for key,value in values.items()))
pathlib.Path(stage, 'password.txt').write_text(secrets.token_hex(20))
PY
mkdir "$stage/certs"
cat > "$MAILFLOW_COMPOSE_OVERLAY" <<YAML
services:
  frontend:
    volumes: !override
      - "$stage/certs:/etc/nginx/ssl"
networks:
  mailflow:
    internal: true
YAML
last_step=compose-config-and-start
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180
frontend=$("${compose[@]}" ps -q frontend)
backend=$("${compose[@]}" ps -q backend)
postgres=$("${compose[@]}" ps -q postgres)
address=$(docker port "$frontend" 80/tcp | head -n 1)
export MAILFLOW_SMOKE_URL="http://$address"
last_step=synthetic-user-registration
python3 - "$stage/password.txt" register <<'PY'
import json, os, pathlib, sys, urllib.request
password = pathlib.Path(sys.argv[1]).read_text()
request = urllib.request.Request(os.environ['MAILFLOW_SMOKE_URL']+'/api/auth/'+sys.argv[2],
    data=json.dumps({'username':'backup-smoke','password':password}).encode(),
    headers={'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'})
with urllib.request.urlopen(request, timeout=30) as response:
    result=json.load(response)
    assert result['user']['username']=='backup-smoke'
PY
docker exec "$postgres" sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "INSERT INTO system_settings(key,value) VALUES ('\''release_smoke'\'','\''before'\'')"' >/dev/null
docker exec "$backend" sh -ec 'printf before > /var/cache/mailflow/images/release-smoke.txt'
printf 'runtime-file-before\n' > "$stage/certs/release-smoke.txt"
age-keygen -o "$stage/identity.txt" >/dev/null 2>&1
recipient=$(age-keygen -y "$stage/identity.txt")
export MAILFLOW_VERIFY_IDENTITY="$stage/identity.txt"
last_step=backup-encryption-and-decryption-verification
bash scripts/release/backup.sh "$stage/snapshot" "$recipient"
last_step=mutating-test-data
docker exec "$postgres" sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE system_settings SET value='\''after'\'' WHERE key='\''release_smoke'\''"' >/dev/null
docker exec "$backend" sh -ec 'printf after > /var/cache/mailflow/images/release-smoke.txt'
printf 'runtime-file-after\n' > "$stage/certs/release-smoke.txt"
last_step=restoring-encrypted-snapshot
MAILFLOW_RESTORE=replace-isolated-instance bash scripts/release/restore.sh "$stage/snapshot" "$stage/identity.txt"
last_step=checking-restored-marker-and-runtime-files
marker=$(docker exec "$postgres" sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT value FROM system_settings WHERE key='\''release_smoke'\''"')
[[ $marker == before ]]
[[ $(cat "$stage/certs/release-smoke.txt") == runtime-file-before ]]
# Inspect stopped backend's restored volume without starting outgoing workers.
docker cp "$backend:/var/cache/mailflow/images/release-smoke.txt" "$stage/restored-marker.txt"
[[ $(cat "$stage/restored-marker.txt") == before ]]
last_step=restored-app-health-and-login
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180
docker exec "$backend" sh -ec 'printf restored-write-ok > /var/cache/mailflow/images/restored-write-check.txt'
python3 - "$stage/password.txt" login <<'PY'
import http.cookiejar, json, os, pathlib, sys, urllib.request
base=os.environ['MAILFLOW_SMOKE_URL']
jar=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
with opener.open(base+'/api/health', timeout=30) as response: assert response.status==200
request=urllib.request.Request(base+'/api/auth/login',
    data=json.dumps({'username':'backup-smoke','password':pathlib.Path(sys.argv[1]).read_text()}).encode(),
    headers={'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'})
with opener.open(request, timeout=30) as response: assert json.load(response)['user']['username']=='backup-smoke'
with opener.open(base+'/api/auth/me', timeout=30) as response: assert json.load(response)['user']['username']=='backup-smoke'
PY
last_step=completed
echo 'Generic encrypted backup/restore smoke checks passed.'
