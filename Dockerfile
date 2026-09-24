# --- Node base ---
FROM node:22-bookworm-slim AS base

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

# Playwright pins an exact Chromium revision per release, so the browser must be
# installed by the SAME playwright version the app imports. Installing it here
# with a hardcoded version silently drifted from the lockfile; the download now
# happens in the runtime stage using the resolved node_modules copy.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# --- Native build toolchain (deps + build stages only) ---
# better-sqlite3 ships prebuilt binaries for linux/amd64 but not for every
# platform (linux/arm64 in particular), where `npm ci` falls back to
# node-gyp and needs python3, make and a C++ compiler. They stay out of the
# runtime image: it only receives the compiled node_modules.
FROM base AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# --- Dependencies stage ---
FROM toolchain AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Build stage ---
FROM toolchain AS build
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

# Install Chromium with the exact playwright build that ships in node_modules,
# so the revision the library looks for is the revision that is on disk. Runs
# as root (still pre-USER-drop) because --with-deps apt-installs system libs.
RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=wg-supervisor-build /wg-supervisor /usr/local/bin/wg-supervisor
RUN chmod 0755 /usr/local/bin/wg-supervisor
COPY public/ ./public/
COPY build.sh ./
RUN bash build.sh && rm build.sh
COPY package.json ./

# Create non-root user for the app process. Only the directories Node writes
# at runtime are ppvda-owned; the app code (dist/, node_modules/, public/)
# stays root-owned so a compromised Node or Chromium process can't persist
# by rewriting it.
#
# The wg-supervisor runs as root and listens on /run/ppvda/wg.sock. That
# directory is root:ppvda 0750 — ppvda can reach the socket but can't
# create, remove or replace entries in it. The supervisor keeps the
# WireGuard config (private key) in its own root-only /run/wg-supervisor.
RUN groupadd -r ppvda && useradd -r -g ppvda -m ppvda \
    && mkdir -p /app/downloads /app/tmp /app/data /run/ppvda \
    && chown ppvda:ppvda /app/downloads /app/tmp /app/data \
    && chown root:ppvda /run/ppvda && chmod 0750 /run/ppvda

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

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
