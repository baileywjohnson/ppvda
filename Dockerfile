# --- Build drk CLI ---
FROM golang:1.26-bookworm AS drk-build
WORKDIR /src
COPY darkreel-cli/ .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /drk .

# --- Node base ---
FROM node:20-bookworm-slim AS base

# Install ffmpeg and Chromium system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    wireguard-tools \
    iproute2 \
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

COPY --from=drk-build /drk /usr/local/bin/drk
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
ENV DRK_BINARY_PATH=/usr/local/bin/drk

EXPOSE 3000
CMD ["node", "dist/index.js"]
