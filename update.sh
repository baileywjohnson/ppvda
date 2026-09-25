#!/usr/bin/env bash
#
# PPVDA auto-updater — deploys the newest *signed* release tag.
#
# Only tags (vMAJOR.MINOR.PATCH) whose SSH signature verifies against
# /etc/ppvda/allowed_signers are deployed, and only as a fast-forward of
# what is running. This runs as root and rebuilds the container, so an
# unverified update would be root on the host: previously any push to main
# (or a compromised GitHub account) was deployed within 24 hours.
#
# One-time setup on the server (the key is the maintainer's SSH signing key):
#   echo "release-signer $(cat id_ed25519.pub)" > /etc/ppvda/allowed_signers
# Releasing:
#   git tag -s v1.2.3 -m v1.2.3   (with git config gpg.format ssh)
#   git push origin v1.2.3
#
# Usage:
#   sudo ./update.sh              # run once
#   sudo ./update.sh --install    # install as a daily cron job (4 AM)
#   sudo ./update.sh --uninstall  # remove the cron job
#
set -euo pipefail

# The checkout this script lives in (cron runs it by absolute path).
REPO_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ALLOWED_SIGNERS="/etc/ppvda/allowed_signers"
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

if [ ! -f "$ALLOWED_SIGNERS" ] || [ -L "$ALLOWED_SIGNERS" ]; then
  error "No signing key at $ALLOWED_SIGNERS — refusing to deploy unverified code (see the header of this script)"
fi

# --- Find the newest release tag ---
CURRENT=$(git rev-parse HEAD)
# --force: a tag that was moved upstream must not be silently kept stale
git fetch --quiet --force --tags origin
TAG=$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
[ -n "$TAG" ] || error "No release tags found"

# --- Verify its signature against the pinned signer ---
if ! git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS" \
     verify-tag "$TAG" >/dev/null 2>&1; then
  error "Tag $TAG is not signed by an allowed signer — refusing to deploy"
fi
LATEST=$(git rev-parse "${TAG}^{commit}")

if [ "$CURRENT" = "$LATEST" ]; then
  info "Already on latest release $TAG (${CURRENT:0:8})"
  exit 0
fi

# --- Only move forward ---
# Every old tag stays validly signed, so without this a re-pointed tag list
# could roll the server back to a vulnerable release.
if ! git merge-base --is-ancestor "$CURRENT" "$LATEST"; then
  error "$TAG (${LATEST:0:8}) does not descend from the running ${CURRENT:0:8} — refusing (rollback or rewritten history)"
fi

info "Update available: ${CURRENT:0:8} -> $TAG (${LATEST:0:8})"

# --- Check out the verified commit and rebuild ---
info "Checking out $TAG..."
git checkout --quiet --detach "$LATEST"

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
  info "Updated to $TAG (${LATEST:0:8}) successfully"
else
  warn "Container started but health check failed — check: docker compose logs -f"
fi
