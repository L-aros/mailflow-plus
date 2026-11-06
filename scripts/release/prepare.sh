#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
[[ "$sha" == "${VERIFIED_SHA:-$sha}" ]] || { echo 'Source differs from validated SHA'; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'Tracked source is dirty'; exit 1; }
out=${PREPARE_OUTPUT:?Set PREPARE_OUTPUT outside the source checkout}
mkdir -p "$out/validation"
out=$(realpath "$out")
[[ "$out/" != "$PWD/"* ]] || { echo 'Output must be outside the checkout'; exit 1; }
baseline=aa1d44b19f467d1352a9a93b3303336820c84dc2
version="$(node -p "require('./backend/package.json').version")-plus.${sha:0:12}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git archive --format=tar.gz --prefix="mailflow-plus-$sha/" "$sha" > "$out/source-$sha.tar.gz"
mkdir -p "$work/baseline" "$work/candidate"
git archive "$sha" | tar -x -C "$work/candidate"
git archive "$baseline" | tar -x -C "$work/baseline"
for spec in "candidate:$sha:$work/candidate:$version" "baseline:$baseline:$work/baseline:4.3.0-pre0076.${baseline:0:12}"; do
  IFS=: read -r role revision context app_version <<< "$spec"
  for component in backend frontend; do
    tag="mailflow-plus/$component:sha-$revision"
    docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
      --file "$context/$component/Dockerfile" --tag "$tag" \
      --build-arg "BUILD_SHA=$revision" --build-arg "VITE_BUILD_SHA=$revision" \
      --build-arg "APP_VERSION=$app_version" \
      --label "org.opencontainers.image.source=https://github.com/L-aros/mailflow-plus" \
      --label "org.opencontainers.image.revision=$revision" \
      --label "org.opencontainers.image.version=$app_version" \
      --label "org.opencontainers.image.url=https://github.com/L-aros/mailflow-plus/tree/$revision" \
      --output "type=oci,dest=$out/$role-$component.oci.tar" \
      --output "type=docker,dest=$out/$role-$component.docker.tar" \
      --metadata-file "$out/validation/$role-$component.build.json" \
      "$context" 2>&1 | tee "$out/validation/$role-$component.build.log"
    docker load --input "$out/$role-$component.docker.tar"
    docker image inspect "$tag" > "$out/validation/$role-$component.inspect.json"
  done
done
# All runtime checks consume the just-loaded archives, never registry/latest.
bash scripts/release/drill.sh "mailflow-plus/backend:sha-$sha" "mailflow-plus/frontend:sha-$sha" \
  "mailflow-plus/backend:sha-$baseline" "mailflow-plus/frontend:sha-$baseline" "$out/validation/drill"
bash scripts/release/backup-smoke.sh "mailflow-plus/backend:sha-$sha" "mailflow-plus/frontend:sha-$sha" "$out/validation/backup-smoke"
docker image inspect postgres:16-alpine redis:7-alpine > "$out/validation/dependencies.inspect.json"
docker save --output "$out/dependencies.docker.tar" postgres:16-alpine redis:7-alpine
cp docker-compose.yml docker-compose.https.yml docker-compose.plus*.yml Caddyfile "$out/"
cp .env.example "$out/env.example"
if [[ -f .env.plus.example ]]; then cp .env.plus.example "$out/env.plus.example"; fi
mkdir -p "$out/scripts/release"
cp scripts/release/backup.sh scripts/release/restore.sh "$out/scripts/release/"
cp LICENSE LICENSE-COMMERCIAL "$out/"
cp docs/release*.md "$out/"
python3 scripts/release/manifest.py "$out" "$sha" "$baseline" "$version"
(cd "$out" && sha256sum --check SHA256SUMS)

