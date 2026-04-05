#!/usr/bin/env bash
#
# PPVDA quickstart — sets up PPVDA on a fresh Linux VPS with Docker.
#
# What this script does:
#   1. Installs Docker and Docker Compose (if not present)
#   2. Clones the repo (or uses the current directory)
#   3. Generates a secure .env configuration
#   4. Optionally configures Mullvad VPN
#   5. Sets up Caddy for automatic HTTPS
#   6. Builds and starts everything with docker compose
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/baileywjohnson/ppvda/main/setup.sh | bash
#
# Or clone first and run locally:
#   git clone https://github.com/baileywjohnson/ppvda.git
#   cd ppvda
#   sudo ./setup.sh
#
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# --- Root check ---
if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root (use sudo ./setup.sh)"
fi

# --- Gather input ---
echo -e "${BOLD}PPVDA Setup${NC}"
echo ""

DOMAIN=""
ADMIN_USER="admin"
ADMIN_PASS=""
MULLVAD_ACCOUNT=""
MULLVAD_LOCATION=""
DARKREEL_URL=""

read -rp "Domain name for PPVDA (e.g., download.example.com), or leave empty for no TLS: " DOMAIN

if [ -n "$DOMAIN" ]; then
  SERVER_IP=$(curl -sf https://ifconfig.me || curl -sf https://api.ipify.org || echo "")
  if [ -n "$SERVER_IP" ]; then
    DOMAIN_IP=$(dig +short "$DOMAIN" 2>/dev/null | tail -1)
    if [ -z "$DOMAIN_IP" ]; then
      warn "Could not resolve $DOMAIN. Make sure the DNS A record points to $SERVER_IP"
      read -rp "Continue anyway? [y/N]: " confirm
      [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && exit 1
    elif [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
      warn "$DOMAIN resolves to $DOMAIN_IP but this server is $SERVER_IP"
      warn "Caddy will fail to get a TLS certificate unless DNS points here."
      read -rp "Continue anyway? [y/N]: " confirm
      [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && exit 1
    else
      info "DNS check passed: $DOMAIN -> $SERVER_IP"
    fi
  fi
fi

read -rp "Admin username [admin]: " input
ADMIN_USER="${input:-admin}"

while true; do
  read -rsp "Admin password (16+ chars, must include letter, number, symbol): " ADMIN_PASS
  echo ""
  if [ ${#ADMIN_PASS} -ge 16 ]; then
    break
  fi
  warn "Password must be at least 16 characters."
done

echo ""
read -rp "Mullvad account number (leave empty to skip VPN): " MULLVAD_ACCOUNT
if [ -n "$MULLVAD_ACCOUNT" ]; then
  read -rp "Mullvad location (e.g., se, us-nyc, ch) [se]: " input
  MULLVAD_LOCATION="${input:-se}"
fi

read -rp "Darkreel server URL (e.g., https://media.example.com), or leave empty: " DARKREEL_URL

echo ""
info "Admin user:  $ADMIN_USER"
[ -n "$DOMAIN" ]           && info "Domain:      $DOMAIN"
[ -n "$MULLVAD_ACCOUNT" ]  && info "Mullvad:     $MULLVAD_LOCATION"
[ -n "$DARKREEL_URL" ]     && info "Darkreel:    $DARKREEL_URL"
echo ""

# --- Install Docker ---
if ! command -v docker &>/dev/null; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  info "Docker installed"
else
  info "Docker already installed"
fi

if ! docker compose version &>/dev/null; then
  error "Docker Compose plugin not found. Install it: https://docs.docker.com/compose/install/"
fi

# --- Clone or use existing repo ---
REPO_DIR="/opt/ppvda"
if [ -f "docker-compose.yml" ] && [ -f "Dockerfile" ]; then
  info "Using current directory as source"
  REPO_DIR="$(pwd)"
elif [ -d "$REPO_DIR" ]; then
  info "Updating existing repo at $REPO_DIR"
  cd "$REPO_DIR" && git pull --quiet
else
  info "Cloning PPVDA..."
  git clone --quiet https://github.com/baileywjohnson/ppvda.git "$REPO_DIR"
fi
cd "$REPO_DIR"

# --- Download darkreel-cli ---
if [ ! -f "darkreel-cli-linux" ]; then
  info "Downloading darkreel-cli..."
  ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")
  curl -fsSL -o darkreel-cli-linux \
    "https://github.com/baileywjohnson/darkreel-cli/releases/latest/download/darkreel-cli-linux-${ARCH}"
  chmod +x darkreel-cli-linux
  info "darkreel-cli downloaded"
fi

# --- Create directories ---
mkdir -p data downloads mullvad

# --- Generate .env ---
JWT_SECRET=$(openssl rand -hex 32)

cat > .env <<EOF
PORT=3000
HOST=0.0.0.0

# Admin (first run only)
PPVDA_ADMIN_USERNAME=${ADMIN_USER}
PPVDA_ADMIN_PASSWORD=${ADMIN_PASS}

# Session secret (persistent across restarts)
JWT_SECRET=${JWT_SECRET}

# Database
DB_PATH=/app/data/ppvda.db

# Downloads
DOWNLOAD_DIR=/app/downloads
MAX_CONCURRENT_DOWNLOADS=3
DOWNLOAD_TIMEOUT_MS=300000

# Browser
BROWSER_TIMEOUT_MS=30000
NETWORK_IDLE_MS=2000

# Logging
LOG_LEVEL=info

# FFmpeg
FFMPEG_PATH=ffmpeg

# Darkreel CLI
DRK_BINARY_PATH=/usr/local/bin/darkreel-cli
DRK_UPLOAD_TIMEOUT_MS=600000

# Features
ENABLE_THUMBNAILS=true
MAX_JOB_HISTORY=100

# Host filtering
PREFERRED_HOSTS=
BLOCKED_HOSTS=
ALLOWED_HOSTS=

# Proxy (if not using Mullvad)
PROXY_URL=
EOF

# Add Mullvad config if provided
if [ -n "$MULLVAD_ACCOUNT" ]; then
  cat >> .env <<EOF

# Mullvad VPN
MULLVAD_ACCOUNT=${MULLVAD_ACCOUNT}
MULLVAD_LOCATION=${MULLVAD_LOCATION}
MULLVAD_CONFIG_DIR=/app/mullvad
EOF

  # Add Darkreel URL as VPN bypass host (so uploads don't go through VPN)
  if [ -n "$DARKREEL_URL" ]; then
    BYPASS_HOST=$(echo "$DARKREEL_URL" | sed -E 's|https?://||' | sed 's|/.*||' | sed 's|:.*||')
    echo "VPN_BYPASS_HOSTS=${BYPASS_HOST}" >> .env
  else
    echo "VPN_BYPASS_HOSTS=" >> .env
  fi
fi

info ".env generated with secure JWT secret"

# --- Install and configure Caddy (if domain provided) ---
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy &>/dev/null; then
    info "Installing Caddy..."
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
    info "Caddy installed"
  fi

  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:3000
}
EOF
  systemctl restart caddy
  info "Caddy configured for https://$DOMAIN"
fi

# --- Build and start ---
info "Building and starting PPVDA (this takes a few minutes on first run)..."
docker compose up --build -d

info "Waiting for PPVDA to start..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  echo ""
  echo -e "${GREEN}${BOLD}PPVDA is running!${NC}"
  echo ""
  if [ -n "$DOMAIN" ]; then
    echo -e "  ${BOLD}URL:${NC}       https://${DOMAIN}"
  else
    echo -e "  ${BOLD}URL:${NC}       http://$(hostname -I | awk '{print $1}'):3000"
  fi
  echo -e "  ${BOLD}Username:${NC}  ${ADMIN_USER}"
  echo ""
  if [ -n "$DARKREEL_URL" ]; then
    echo -e "  ${BOLD}Next step:${NC} Log in, go to Settings, and enter your Darkreel"
    echo -e "  credentials (${DARKREEL_URL}) to enable encrypted uploads."
  else
    echo -e "  ${BOLD}Next step:${NC} Log in and paste a video URL to get started."
    echo -e "  To enable encrypted storage, set up a Darkreel server and"
    echo -e "  configure it in Settings."
  fi
  echo ""
  echo "  Useful commands:"
  echo "    docker compose logs -f        # follow logs"
  echo "    docker compose restart        # restart"
  echo "    docker compose down           # stop"
  echo "    docker compose up --build -d  # rebuild after updates"
  echo ""
else
  warn "PPVDA may still be starting (Chromium install takes time)."
  echo "  Check status: docker compose logs -f"
fi
