# Overridable nginx base for hosts whose older kernels cannot exec binaries from
# the newest Alpine package repo (e.g. some NAS units) — set to an older tag like
# nginx:1.27-alpine via the NGINX_BASE build arg.
ARG NGINX_BASE=nginx:alpine

FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
# electron is a devDependency used only for desktop packaging (electron-builder),
# never by the web/vite build. Skip its ~100MB binary download so the multi-arch
# image build (incl. arm64 under QEMU) stays fast and can't fail on a flaky fetch.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

COPY frontend/ .

ARG VITE_BUILD_SHA
ENV VITE_BUILD_SHA=${VITE_BUILD_SHA:-dev}
ARG APP_VERSION=4.3.0-plus.dev
ENV VITE_APP_VERSION=${APP_VERSION}
ARG VITE_EMAIL_DIV_RENDER
ENV VITE_EMAIL_DIV_RENDER=${VITE_EMAIL_DIV_RENDER:-false}

RUN npm run build && node --input-type=module -e 'import fs from "node:fs"; const sha=process.env.VITE_BUILD_SHA; fs.writeFileSync("dist/build-info.json",JSON.stringify({product:"MailFlow Plus",version:process.env.VITE_APP_VERSION,sha,sourceUrl:"https://github.com/L-aros/mailflow-plus/tree/"+(/^[a-f0-9]{40}$/.test(sha)?sha:"mailflow-plus")})+"\n")'

FROM ${NGINX_BASE}

ARG VITE_BUILD_SHA=dev
ARG APP_VERSION=4.3.0-plus.dev
LABEL org.opencontainers.image.title="MailFlow Plus frontend" \
      org.opencontainers.image.source="https://github.com/L-aros/mailflow-plus" \
      org.opencontainers.image.revision="${VITE_BUILD_SHA}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      io.mailflow.component.license="GPL-3.0" \
      io.mailflow.license.notice="Root LICENSE: AGPL-3.0; frontend/package.json: GPL-3.0 (original metadata preserved)"

RUN apk add --no-cache openssl

COPY --from=builder /app/dist /usr/share/nginx/html
COPY LICENSE LICENSE-COMMERCIAL /usr/share/mailflow/
COPY frontend/package.json frontend/package-lock.json /usr/share/mailflow/frontend/
COPY LICENSE LICENSE-COMMERCIAL /usr/share/nginx/html/licenses/
COPY frontend/package.json /usr/share/nginx/html/licenses/frontend-package.json

# The config is baked in, NOT rendered at runtime. 3.4.3 made it an envsubst template to get
# the resolver right on non-Docker runtimes (#448), but that made /etc/nginx/conf.d a startup
# write and broke read-only root filesystems (#453) — the image's entrypoint runs under
# `set -e`, so the failed write stopped nginx booting at all.
#
# Only one marked line is rewritten now, in place, and failing to rewrite it is survivable:
# 16-detect-resolver.sh corrects the resolver from the container's real /etc/resolv.conf when
# it can, and leaves the shipped Docker default when it cannot. Read-only filesystems start
# either way. The resolver is NOT an include — `resolve` requires one, so a glob that matched
# nothing would stop nginx booting.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/detect-resolver.sh /docker-entrypoint.d/16-detect-resolver.sh
COPY frontend/set-backend.sh /docker-entrypoint.d/17-set-backend.sh
COPY frontend/generate-cert.sh /docker-entrypoint.d/10-generate-cert.sh
COPY frontend/set-tls.sh /docker-entrypoint.d/18-set-tls.sh
RUN chmod +x /docker-entrypoint.d/10-generate-cert.sh /docker-entrypoint.d/16-detect-resolver.sh /docker-entrypoint.d/17-set-backend.sh /docker-entrypoint.d/18-set-tls.sh

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
