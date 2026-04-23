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

# --- Runtime stage ---
FROM base AS runtime
WORKDIR /app

# Note: the darkreel-cli binary is no longer shipped — uploads go through the
# in-process Shape-2 client in src/darkreel/client.ts. Removed both the unpinned
# GitHub download (supply-chain risk: unverified latest-release fetch) and the
# DRK_BINARY_PATH env var it exposed (dead-code attack surface).

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public/ ./public/
COPY build.sh ./
RUN bash build.sh && rm build.sh
COPY package.json ./

# Create non-root user for the app process
RUN groupadd -r ppvda && useradd -r -g ppvda -m ppvda \
    && mkdir -p /app/downloads /app/tmp /app/mullvad /app/data \
    && chown -R ppvda:ppvda /app

# Entrypoint drops to the `ppvda` user when Mullvad/WireGuard is NOT
# configured. When Mullvad IS configured, the container must run as root
# (requires NET_ADMIN capability and /dev/net/tun) — start with
# --cap-add=NET_ADMIN and --device=/dev/net/tun (docker-compose handles this).
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
