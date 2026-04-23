# --- Node base ---
FROM node:20-bookworm-slim AS base

# Install ffmpeg, WireGuard tools, gosu (for privilege dropping)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wireguard-tools \
    iproute2 \
    openresolv \
    procps \
    iptables \
    ca-certificates \
    curl \
    gosu \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.59.1 install --with-deps chromium

WORKDIR /app

# --- Dependencies stage ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Build stage ---
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- wg-supervisor build stage ---
# Builds the tiny privileged helper that owns CAP_NET_ADMIN operations.
# Static binary, no C deps, Linux-only build tag so the supervisor source
# doesn't interfere with host-OS dev builds. See wg-supervisor/main.go.
FROM golang:1.26-alpine AS wg-supervisor-build
WORKDIR /src
COPY wg-supervisor/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /wg-supervisor .

# --- Runtime stage ---
FROM base AS runtime
WORKDIR /app

# Note: the darkreel-cli binary is no longer shipped — uploads go through the
# in-process Shape-2 client in src/darkreel/client.ts. Removed both the unpinned
# GitHub download (supply-chain risk: unverified latest-release fetch) and the
# DRK_BINARY_PATH env var it exposed (dead-code attack surface).

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=wg-supervisor-build /wg-supervisor /usr/local/bin/wg-supervisor
RUN chmod 0755 /usr/local/bin/wg-supervisor
COPY public/ ./public/
COPY build.sh ./
RUN bash build.sh && rm build.sh
COPY package.json ./

# Create non-root user for the app process. The wg-supervisor runs as root
# and listens on /run/ppvda/wg.sock; we pre-create the directory so the
# socket can be chowned to ppvda at startup.
RUN groupadd -r ppvda && useradd -r -g ppvda -m ppvda \
    && mkdir -p /app/downloads /app/tmp /app/mullvad /app/data /run/ppvda \
    && chown -R ppvda:ppvda /app /run/ppvda

# Entrypoint drops to the `ppvda` user in both Mullvad and non-Mullvad
# deployments. When Mullvad IS configured, the container still needs
# --cap-add=NET_ADMIN and --device=/dev/net/tun on the docker run / compose
# side, but only wg-supervisor uses those capabilities — the Node process
# (and therefore Chromium) runs unprivileged so the browser sandbox works.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/app/downloads
ENV TEMP_DIR=/app/tmp
ENV MULLVAD_CONFIG_DIR=/app/mullvad

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
