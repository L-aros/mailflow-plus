FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
# This stage runs on the build machine, but sharp's prebuilt image library is native code: install
# the one for the platform being built (an arm64 image built on amd64 needs the arm64 binary).
ARG TARGETARCH
RUN npm ci --omit=dev --os=linux --libc=musl --cpu="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)"

FROM node:22-alpine AS runtime

WORKDIR /app

ARG BUILD_SHA=dev
ARG APP_VERSION=4.3.0-plus.dev
ENV BUILD_SHA=${BUILD_SHA:-dev}
ENV UPDATE_CHECK_DISABLED=true
ENV UPDATE_CHECK_REPO=L-aros/mailflow-plus
LABEL org.opencontainers.image.title="MailFlow Plus backend" \
      org.opencontainers.image.source="https://github.com/L-aros/mailflow-plus" \
      org.opencontainers.image.revision="${BUILD_SHA}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      io.mailflow.license.notice="Original LICENSE and LICENSE-COMMERCIAL preserved in /usr/share/mailflow"

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY LICENSE LICENSE-COMMERCIAL /usr/share/mailflow/
COPY backend/package.json backend/package-lock.json /usr/share/mailflow/backend/
RUN APP_VERSION="${APP_VERSION}" BUILD_SHA="${BUILD_SHA}" node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync("build-meta.json", JSON.stringify({version:process.env.APP_VERSION.replace(/^v[.]?/, ""),sha:process.env.BUILD_SHA})+"\n")' && \
    mkdir -p /var/cache/mailflow/images && \
    chown -R node:node /app /var/cache/mailflow

USER node

EXPOSE 3000

CMD ["node", "src/index.js"]
