# --- Node base ---
FROM node:20-bookworm-slim AS base

# Install ffmpeg, WireGuard tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wireguard-tools \
    iproute2 \
    openresolv \
    procps \
    iptables \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.58.2 install --with-deps chromium

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

# Download latest darkreel-cli from GitHub releases
ARG TARGETARCH
RUN curl -fsSL -o /usr/local/bin/darkreel-cli \
    "https://github.com/baileywjohnson/darkreel-cli/releases/latest/download/darkreel-cli-linux-${TARGETARCH}" \
    && chmod +x /usr/local/bin/darkreel-cli

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public/ ./public/
COPY build.sh ./
RUN bash build.sh && rm build.sh
COPY package.json ./

# Create non-root user (used when Mullvad/WireGuard is NOT needed)
RUN groupadd -r ppvda && useradd -r -g ppvda -m ppvda \
    && mkdir -p /app/downloads /app/tmp /app/mullvad /app/data \
    && chown -R ppvda:ppvda /app

# Note: When using Mullvad/WireGuard, the container must run as root
# (requires NET_ADMIN capability and /dev/net/tun). Use docker-compose
# or set --cap-add=NET_ADMIN and --device=/dev/net/tun.
# When NOT using Mullvad, run with: docker run --user ppvda ...

ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/app/downloads
ENV TEMP_DIR=/app/tmp
ENV MULLVAD_CONFIG_DIR=/app/mullvad
ENV DRK_BINARY_PATH=/usr/local/bin/darkreel-cli

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
