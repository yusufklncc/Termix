# Stage 0: every plugin's package.json and manifest.json and nothing else.
# npm ci needs each workspace package.json in place or it silently skips it,
# and a glob COPY flattens paths, so the tree is trimmed here instead. The
# deps layer below stays cached until one of these files changes. Upstream
# has no plugins in the tree and dropped this stage; this fork builds five.
# trixie, not the default node:24-slim, which is still Debian 12.
#
# Bookworm's zlib is 1.2.13, and the critical CVE-2023-45853 against it has no
# fix there -- trixie carries 1.3.1, where that one does not apply. Its
# perl-base is current too, so the upgrade below finds nothing left to do and
# stays only to catch what Debian ships next. Every stage moves together: the
# native modules are built in one and copied into another, and they should be
# built against the libc they run on.
FROM node:24-trixie-slim AS workspace-manifests
WORKDIR /src
COPY plugins ./plugins
RUN find plugins -mindepth 2 -maxdepth 2 ! -name package.json ! -name manifest.json -exec rm -rf {} +

# Stage 1: Install dependencies
# The builders only produce JS, so they run on the build machine's own arch
# once instead of under QEMU per target. Rolldown hangs under arm64 emulation.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=workspace-manifests /src/plugins ./plugins
COPY .npmrc ./
COPY vendor ./vendor

COPY scripts/patch-ssh2-agent.cjs ./scripts/

RUN npm ci --ignore-scripts && \
    node scripts/patch-ssh2-agent.cjs && \
    npm cache clean --force

# Stage 2: Build frontend
FROM deps AS frontend-builder
WORKDIR /app

COPY . .

RUN find public/fonts -name "*.ttf" ! -name "*Regular.ttf" ! -name "*Bold.ttf" ! -name "*Italic.ttf" -delete

RUN npm cache clean --force && \
    TERMIX_RUNTIME_BASE_PATH=true NODE_OPTIONS="--max-old-space-size=3072" npm run build

# Stage 3: Build backend
FROM deps AS backend-builder
WORKDIR /app

COPY . .

# Bundled plugin downloads show in the plugin store, so keep them between builds.
RUN --mount=type=cache,target=/app/node_modules/.cache/termix-bundled-plugins \
    npm run build:backend

# Stage 4: build OPKSSH, rather than download the release binary.
#
# That binary is where every Go finding in this image lives. Upstream builds a
# release once, and the Go it was built with ages from that day: v0.18.0 ships
# go1.26.6, so each stdlib CVE published afterwards sits in the image until
# upstream happens to cut a new release. Building the same tag here with a
# current toolchain settles that without waiting for anyone.
#
# The three golang.org/x modules move with it. Upstream's own test suite passes
# with them -- checked against a build of the unmodified tag first, because one
# of its tests fails on the absence of /etc/opk/providers either way and that
# would have read as a regression.
#
# Everything is pinned: the toolchain by tag, the source by tag, each module by
# version. The build has to come out the same twice, because the plugin trusts
# the bundled binary by checksum.
FROM golang:1.27.2 AS opkssh-builder
ARG TARGETARCH
ARG OPKSSH_VERSION=v0.18.0
ARG OPKSSH_X_CRYPTO=v0.58.0
ARG OPKSSH_X_MOD=v0.42.0
ARG OPKSSH_X_TEXT=v0.43.0
WORKDIR /src

RUN git clone --depth 1 --branch "$OPKSSH_VERSION" \
      https://github.com/openpubkey/opkssh.git .

RUN go get "golang.org/x/crypto@$OPKSSH_X_CRYPTO" \
           "golang.org/x/mod@$OPKSSH_X_MOD" \
           "golang.org/x/text@$OPKSSH_X_TEXT" && \
    go mod tidy

# CGO_ENABLED=0 and these ldflags are what upstream's goreleaser uses.
# -trimpath so the binary does not carry this builder's paths.
RUN mkdir -p /opkssh && \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" \
      go build -trimpath -ldflags "-s -w -X main.Version=$OPKSSH_VERSION" \
        -o "/opkssh/opkssh-linux-${TARGETARCH}" . && \
    chmod 755 "/opkssh/opkssh-linux-${TARGETARCH}" && \
    # Written beside the binary because it is this build's, not a release's.
    # The entrypoint hands it to the plugin, which otherwise downloads
    # upstream's -- the build this stage exists to avoid.
    sha256sum "/opkssh/opkssh-linux-${TARGETARCH}" | cut -d" " -f1 \
      > /opkssh/sha256.txt && \
    printf %s "$OPKSSH_VERSION" > /opkssh/version.txt

# Stage 5: Production dependencies only
FROM node:24-trixie-slim AS production-deps
WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# The plugin SDK is a workspace package core imports at runtime, so npm ci
# has to see it to link it and install its dependencies.
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY .npmrc ./
COPY vendor ./vendor

COPY scripts/patch-ssh2-agent.cjs ./scripts/

# ssh2's native crypto crashes Node 24 when a cipher is freed, so ssh2 uses
# OpenSSL instead (chacha20-poly1305 is then left out).
RUN npm ci --omit=dev --ignore-scripts && \
    node scripts/patch-ssh2-agent.cjs && \
    rm -rf node_modules/better-sqlite3/prebuilds && \
    npm run build-release --prefix node_modules/better-sqlite3 && \
    test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node && \
    npm rebuild bcryptjs && \
    rm -rf node_modules/ssh2/lib/protocol/crypto/build && \
    npm cache clean --force

# Stage 6: Final optimized image
FROM node:24-trixie-slim
WORKDIR /app

# The release the opkssh-builder stage built, so the plugin knows which
# version it has. Its checksum is not pinned here: the binary is built in this
# image, so the sum belongs to the build and travels beside it, in
# opkssh-bundled/sha256.txt, which the entrypoint exports.
ARG OPKSSH_VERSION=v0.18.0

ENV DATA_DIR=/app/data \
    OPKSSH_BUNDLED_DIR=/app/opkssh-bundled \
    OPKSSH_VERSION=$OPKSSH_VERSION \
    PORT=8080 \
    NODE_ENV=production

# upgrade, because the base is where the findings are and the node image is
# rebuilt on its own schedule: today that is one package, perl-base, carrying
# three criticals Debian fixed. Pulling a fresh base does not bring it.
#
# npm goes because nothing here runs it -- the backend and every plugin were
# checked -- and the copy inside the node image is its own dependency tree,
# some of it older than ours: undici, ip-address, brace-expansion and
# postcss-selector-parser were all reported against npm's vendored copies
# while /app/node_modules already had the fixed versions.
RUN apt-get update && apt-get -y upgrade && \
    apt-get install -y nginx gettext-base openssl ca-certificates gosu wget && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    mkdir -p /app/data /app/uploads /app/nginx /tmp/nginx && \
    chown -R node:node /app /tmp/nginx && \
    chmod 755 /app/data /app/uploads /app/nginx /tmp/nginx

COPY docker/nginx.conf /app/nginx/nginx.conf.template
COPY docker/nginx-https.conf /app/nginx/nginx-https.conf.template

COPY --chown=node:node --from=frontend-builder /app/dist /app/html

COPY --chown=node:node --from=production-deps /app/node_modules /app/node_modules
COPY --chown=node:node --from=backend-builder /app/dist/backend ./dist/backend
# Plugins pinned in docker/bundled-plugins.json, resolved as dist/plugins by
# getBundledPluginsDir().
COPY --chown=node:node --from=backend-builder /app/dist/plugins ./dist/plugins
# Target of node_modules/@termix-ssh/plugin-sdk, which core and the plugins import.
COPY --chown=node:node --from=backend-builder /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --chown=node:node --from=backend-builder /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
# Pre-baked OPKSSH binary. The opkssh plugin uses it when its checksum
# matches, so an offline install never downloads one.
COPY --chown=node:node --from=opkssh-builder /opkssh /app/opkssh-bundled
COPY --chown=node:node package.json ./
# Schema for Postgres and MySQL. Unused by the default SQLite deployment, which
# builds its tables at startup instead.
COPY --chown=node:node drizzle ./drizzle

VOLUME ["/app/data"]

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:30001/health || exit 1

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
