#!/usr/bin/env bash
#
# PPVDA auto-updater — checks for new commits on main and rebuilds.
#
# Fetches the latest commit from GitHub. If it's newer than what's
# running, pulls and rebuilds the Docker container.
#
# Usage:
#   sudo ./update.sh              # run once
#   sudo ./update.sh --install    # install as a daily cron job (4 AM)
#   sudo ./update.sh --uninstall  # remove the cron job
#
set -euo pipefail

REPO_DIR="/opt/ppvda"
CRON_FILE="/etc/cron.d/ppvda-update"
LOG_FILE="/var/log/ppvda-update.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# --- Install/uninstall cron ---
if [ "${1:-}" = "--install" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    error "Must be root to install cron job"
  fi
  SCRIPT_PATH=$(readlink -f "$0")
  cat > "$CRON_FILE" <<EOF
# Check for PPVDA updates daily at 4 AM
0 4 * * * root $SCRIPT_PATH >> $LOG_FILE 2>&1
EOF
  info "Auto-update cron job installed (daily at 4 AM)"
  info "Logs: $LOG_FILE"
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$CRON_FILE"
  info "Auto-update cron job removed"
  exit 0
fi

# --- Root check ---
if [ "$(id -u)" -ne 0 ]; then
  error "Must be root (use sudo ./update.sh)"
fi

# --- Check repo exists ---
if [ ! -d "$REPO_DIR/.git" ]; then
  error "PPVDA repo not found at $REPO_DIR"
fi

cd "$REPO_DIR"

# --- Get current and latest commits ---
CURRENT=$(git rev-parse HEAD)
git fetch --quiet origin main

LATEST=$(git rev-parse origin/main)

if [ "$CURRENT" = "$LATEST" ]; then
  info "Already on latest commit (${CURRENT:0:8})"
  exit 0
fi

info "Update available: ${CURRENT:0:8} -> ${LATEST:0:8}"

# --- Pull and rebuild ---
info "Pulling latest changes..."
git checkout --quiet main
git pull --quiet origin main

info "Rebuilding container (this may take a few minutes)..."
docker compose up --build -d

# --- Health check ---
info "Waiting for PPVDA to start..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  info "Updated to ${LATEST:0:8} successfully"
else
  warn "Container started but health check failed — check: docker compose logs -f"
fi
