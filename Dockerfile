# --- Node base ---
FROM node:20-bookworm-slim AS base

# Install ffmpeg, WireGuard tools, and curl for downloading darkreel-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wireguard-tools \
    iproute2 \
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

# Download darkreel-cli binary from GitHub releases
# Override DARKREEL_CLI_VERSION at build time to pin a specific version
ARG DARKREEL_CLI_VERSION=latest
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    if [ "$DARKREEL_CLI_VERSION" = "latest" ]; then \
      URL="https://github.com/baileywjohnson/darkreel-cli/releases/latest/download/darkreel-cli-linux-${ARCH}"; \
    else \
      URL="https://github.com/baileywjohnson/darkreel-cli/releases/download/${DARKREEL_CLI_VERSION}/darkreel-cli-linux-${ARCH}"; \
    fi && \
    echo "Downloading darkreel-cli from ${URL}" && \
    curl -fSL -o /usr/local/bin/darkreel-cli "${URL}" && \
    chmod +x /usr/local/bin/darkreel-cli

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public/ ./public/
COPY package.json ./

# Create non-root user (used when Mullvad/WireGuard is NOT needed)
RUN groupadd -r ppvda && useradd -r -g ppvda -m ppvda \
    && mkdir -p /app/downloads /app/tmp /app/mullvad \
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
CMD ["node", "dist/index.js"]
