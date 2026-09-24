#!/usr/bin/env bash
#
# PPVDA quickstart — sets up PPVDA on a fresh Linux VPS with Docker.
#
# What this script does:
#   1. Applies system updates and installs security tooling
#   2. Configures UFW firewall (SSH, HTTP, HTTPS only)
#   3. Installs fail2ban and enables automatic security updates
#   4. Optionally creates a personal SSH user and disables root login
#   5. Installs Docker and Docker Compose from Docker's signed apt repository
#      (if not present)
#   6. Clones the repo (or uses the current directory) and checks out the
#      newest release tag signed by the pinned release signer
#   7. Generates a secure .env configuration
#   8. Optionally configures Mullvad VPN
#   9. Sets up Caddy for automatic HTTPS (with optional access log privacy)
#   10. Sets up daily encrypted database backups
#   11. Builds and starts everything with docker compose
#
# Usage — clone, check out and verify a signed release, read the script,
# then run it (it runs as root, so don't pipe it from the network into a
# shell; its prompts also need a terminal on stdin):
#   git clone https://github.com/baileywjohnson/ppvda.git
#   cd ppvda
#   git checkout vX.Y.Z   # newest release; verify it, see README "Deploy"
#   less setup.sh
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

# The prompts below read from stdin. Piped in (`curl … | bash`) they would
# consume the rest of the script as answers.
if [ ! -t 0 ]; then
  error "Run this script from a file with a terminal on stdin (sudo ./setup.sh), not piped into a shell"
fi

ALLOWED_SIGNERS="/etc/ppvda/allowed_signers"
# Docker's apt repository signing key (docs.docker.com/engine/install).
DOCKER_GPG_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

# --- Gather input ---
echo -e "${BOLD}PPVDA Setup${NC}"
echo ""

DOMAIN=""
ADMIN_USER="admin"
ADMIN_PASS=""
MULLVAD_ACCOUNT=""
MULLVAD_LOCATION=""
DARKREEL_URL=""
SSH_USER=""
DISABLE_ACCESS_LOGS="y"

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
read -rp "Create a personal SSH user? Enter username (or leave empty to skip): " SSH_USER

if [ -n "$DOMAIN" ]; then
  echo ""
  read -rp "Disable Caddy access logs for privacy? (recommended) [Y/n]: " DISABLE_ACCESS_LOGS_INPUT
  [ "$DISABLE_ACCESS_LOGS_INPUT" = "n" ] || [ "$DISABLE_ACCESS_LOGS_INPUT" = "N" ] && DISABLE_ACCESS_LOGS="n"
fi

# Releases are SSH-signed git tags. Pinning the signer's public key lets this
# script build the newest signed release instead of whatever the branch head
# is, and is what update.sh verifies against.
RELEASE_SIGNER_KEY=""
if [ ! -f "$ALLOWED_SIGNERS" ]; then
  echo ""
  echo "Release signer SSH public key (e.g. ssh-ed25519 AAAA...), obtained from the"
  while true; do
    read -rp "maintainer through a channel you trust — or leave empty to skip: " RELEASE_SIGNER_KEY
    if [ -z "$RELEASE_SIGNER_KEY" ] || [[ "$RELEASE_SIGNER_KEY" =~ ^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)\ [A-Za-z0-9+/]+=*(\ .*)?$ ]]; then
      break
    fi
    warn "That doesn't look like an SSH public key."
  done
fi

AUTO_UPDATE="n"
echo ""
read -rp "Enable auto-updates? (daily check for new signed releases) [y/N]: " AUTO_UPDATE
if { [ "$AUTO_UPDATE" = "y" ] || [ "$AUTO_UPDATE" = "Y" ]; } && [ ! -f "$ALLOWED_SIGNERS" ] && [ -z "$RELEASE_SIGNER_KEY" ]; then
  warn "Auto-updates only deploy tags signed by a pinned signer; with none pinned they will refuse to run."
fi

echo ""
info "Admin user:  $ADMIN_USER"
[ -n "$DOMAIN" ]           && info "Domain:      $DOMAIN"
[ -n "$MULLVAD_ACCOUNT" ]  && info "Mullvad:     $MULLVAD_LOCATION"
[ -n "$DARKREEL_URL" ]     && info "Darkreel:    $DARKREEL_URL"
[ -n "$SSH_USER" ]         && info "SSH user:    $SSH_USER"
[ "$AUTO_UPDATE" = "y" ] || [ "$AUTO_UPDATE" = "Y" ] && info "Auto-update: enabled"
echo ""

# ============================================================
# SYSTEM HARDENING
# ============================================================

# --- System updates ---
info "Applying system updates..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq >/dev/null 2>&1
info "System updated"

# --- Install security packages ---
info "Installing security packages..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban unattended-upgrades ufw >/dev/null
info "fail2ban, unattended-upgrades, and UFW installed"

# --- Enable unattended security updates ---
cat > /etc/apt/apt.conf.d/20auto-upgrades <<EOF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
info "Automatic security updates enabled"

# --- Configure fail2ban ---
systemctl enable --now fail2ban >/dev/null 2>&1
info "fail2ban enabled"

# --- Firewall ---
ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null 2>&1
ufw default allow outgoing >/dev/null 2>&1
ufw allow OpenSSH >/dev/null 2>&1
ufw allow 80 >/dev/null 2>&1
ufw allow 443 >/dev/null 2>&1
ufw --force enable >/dev/null 2>&1
info "UFW firewall enabled (SSH, HTTP, HTTPS only)"

# --- Create personal SSH user ---
if [ -n "$SSH_USER" ]; then
  if ! id -u "$SSH_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$SSH_USER"
    usermod -aG sudo "$SSH_USER"

    # Copy root's SSH keys to the new user
    if [ -f /root/.ssh/authorized_keys ]; then
      mkdir -p "/home/${SSH_USER}/.ssh"
      cp /root/.ssh/authorized_keys "/home/${SSH_USER}/.ssh/"
      chown -R "${SSH_USER}:${SSH_USER}" "/home/${SSH_USER}/.ssh"
      chmod 700 "/home/${SSH_USER}/.ssh"
      chmod 600 "/home/${SSH_USER}/.ssh/authorized_keys"
    fi

    info "Created SSH user '$SSH_USER' with sudo access"
    echo ""
    warn "Set a password for $SSH_USER (needed for sudo):"
    passwd "$SSH_USER"
    echo ""
  else
    info "SSH user '$SSH_USER' already exists"
  fi
fi

# --- Disable root SSH login ---
if grep -q "^PermitRootLogin yes" /etc/ssh/sshd_config 2>/dev/null || grep -q "^#PermitRootLogin" /etc/ssh/sshd_config 2>/dev/null; then
  if [ -n "$SSH_USER" ]; then
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
    systemctl restart ssh
    info "Root SSH login disabled"
  else
    warn "Skipping root SSH disable — no personal SSH user was created"
    warn "Run this manually after setting up SSH access for another user:"
    warn "  sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && systemctl restart ssh"
  fi
fi

# ============================================================
# DEPLOY USER & CI/CD
# ============================================================

# --- Create deploy user (for CI/CD) ---
if ! id -u deploy &>/dev/null; then
  useradd -m -s /bin/bash deploy
  info "Created deploy user"
else
  info "Deploy user already exists"
fi

# Create the deploy script (the ONLY thing deploy can sudo).
# Accepts a commit SHA as argument, verifies its Ed25519 signature
# against the public key at /etc/ppvda/signing.pub, then checks out
# that exact commit and rebuilds. Without the key installed, or without a
# valid signature, the deploy is rejected. The signing key must be kept
# off GitHub — a key stored as an Actions secret is only as safe as every
# action and token with access to it.
cat > /usr/local/bin/ppvda-deploy << 'SCRIPT'
#!/bin/bash
set -euo pipefail

COMMIT_SHA="${1:-}"
REPO_DIR="/opt/ppvda"
SIGNING_PUB="/etc/ppvda/signing.pub"
HASH_FILE="/home/deploy/commit.hash"
SIG_FILE="/home/deploy/commit.sig"

if ! [[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: ppvda-deploy <40-char commit sha>" >&2
  exit 1
fi

# Fail closed: no key, no deploy.
if [ ! -f "$SIGNING_PUB" ]; then
  echo "ERROR: no signing key at $SIGNING_PUB — deploy rejected" >&2
  exit 1
fi
if [ ! -f "$SIG_FILE" ] || [ ! -f "$HASH_FILE" ]; then
  echo "ERROR: commit.hash and commit.sig must be in /home/deploy/" >&2
  exit 1
fi

# Work on root-owned copies. /home/deploy is writable by the deploy user,
# who could otherwise swap the files between the checks below.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp --no-dereference -- "$HASH_FILE" "$WORK/commit.hash"
cp --no-dereference -- "$SIG_FILE" "$WORK/commit.sig"
rm -f "$HASH_FILE" "$SIG_FILE"
[ -f "$WORK/commit.hash" ] && [ ! -L "$WORK/commit.hash" ] || { echo "ERROR: bad commit.hash" >&2; exit 1; }

if [ "$(tr -d '[:space:]' < "$WORK/commit.hash")" != "$COMMIT_SHA" ]; then
  echo "ERROR: commit hash mismatch" >&2
  exit 1
fi
openssl pkeyutl -verify -pubin \
  -inkey "$SIGNING_PUB" \
  -rawin -in "$WORK/commit.hash" -sigfile "$WORK/commit.sig" || {
  echo "ERROR: signature verification failed — deploy rejected" >&2
  exit 1
}
echo "Signature verified for commit $COMMIT_SHA"

# Fetch and checkout the verified commit — forward only. Every commit ever
# signed stays valid, so this is what stops a rollback to an old one.
cd "$REPO_DIR"
git fetch --quiet origin
if ! git merge-base --is-ancestor HEAD "$COMMIT_SHA"; then
  echo "ERROR: $COMMIT_SHA does not descend from the deployed commit — refusing" >&2
  exit 1
fi
git checkout --quiet "$COMMIT_SHA"
docker compose up --build -d
SCRIPT
chmod 755 /usr/local/bin/ppvda-deploy

# Restricted sudo — deploy can ONLY run this one script
echo 'deploy ALL=(ALL) NOPASSWD: /usr/local/bin/ppvda-deploy' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
info "Deploy script installed with restricted sudo"

# --- Install signing public key directory ---
mkdir -p /etc/ppvda
if [ -n "$RELEASE_SIGNER_KEY" ]; then
  echo "release-signer ${RELEASE_SIGNER_KEY}" > "$ALLOWED_SIGNERS"
  chmod 644 "$ALLOWED_SIGNERS"
  info "Release signer pinned at $ALLOWED_SIGNERS"
fi
if [ ! -f /etc/ppvda/signing.pub ]; then
  warn "No signing public key found at /etc/ppvda/signing.pub"
  warn "CI/CD signature verification will be skipped without it."
  warn "Copy your signing public key to the VPS:"
  warn "  scp ppvda_signing.pub youruser@server:/etc/ppvda/signing.pub"
  echo ""
fi

# ============================================================
# DOCKER & PPVDA INSTALLATION
# ============================================================

# --- Install Docker ---
# From Docker's own apt repository, with its signing key checked against the
# published fingerprint — not `curl https://get.docker.com | sh`, which runs
# whatever that URL serves as root. After this, apt verifies every package.
install_docker() {
  local os_id codename key_tmp fpr
  os_id=$(. /etc/os-release && echo "${ID:-}")
  codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
  case "$os_id" in
    ubuntu|debian) ;;
    *) error "Automatic Docker install supports Debian and Ubuntu only. Install Docker Engine and the Compose plugin (https://docs.docker.com/engine/install/), then re-run." ;;
  esac
  [ -n "$codename" ] || error "Could not determine the ${os_id} release codename from /etc/os-release"

  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  key_tmp=$(mktemp)
  curl -fsSL "https://download.docker.com/linux/${os_id}/gpg" -o "$key_tmp"
  fpr=$(gpg --batch --with-colons --show-keys "$key_tmp" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  if [ "$fpr" != "$DOCKER_GPG_FPR" ]; then
    rm -f "$key_tmp"
    error "Docker's apt signing key has fingerprint '${fpr}', expected ${DOCKER_GPG_FPR} — aborting"
  fi
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg "$key_tmp"
  rm -f "$key_tmp"
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${os_id} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
}

if ! command -v docker &>/dev/null; then
  info "Installing Docker from Docker's apt repository..."
  install_docker
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
  info "Using existing repo at $REPO_DIR"
else
  info "Cloning PPVDA..."
  git clone --quiet https://github.com/baileywjohnson/ppvda.git "$REPO_DIR"
fi
cd "$REPO_DIR"

# --- Check out the newest signed release ---
# Same trust model as update.sh: only a vX.Y.Z tag whose SSH signature
# verifies against $ALLOWED_SIGNERS counts as a release. Building the branch
# head would run whatever was last pushed, as root.
select_release() {
  local tag
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    warn "$REPO_DIR is not a git checkout — building it as is, UNVERIFIED."
    return
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    warn "$REPO_DIR has local changes — building the working tree as is, UNVERIFIED."
    return
  fi
  git fetch --quiet --force --tags origin || warn "Could not fetch release tags from origin"
  if [ ! -f "$ALLOWED_SIGNERS" ] || [ -L "$ALLOWED_SIGNERS" ]; then
    warn "No release signer pinned at $ALLOWED_SIGNERS, so nothing can be verified."
    warn "Building $(git rev-parse --short HEAD) UNVERIFIED. To fix: pin the signer (see update.sh) and re-run."
    return
  fi
  for tag in $(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true); do
    if git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS" \
         verify-tag "$tag" >/dev/null 2>&1; then
      git checkout --quiet --detach "${tag}^{commit}"
      info "Building signed release $tag ($(git rev-parse --short HEAD))"
      return
    fi
  done
  warn "No release tag signed by the pinned signer exists yet."
  warn "Building $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD) UNVERIFIED; update.sh moves to the first signed release that descends from it."
}
select_release

# --- Create directories ---
mkdir -p data downloads

# --- Generate .env ---
# The admin password goes to a separate file (deleted after first start)
# to avoid leaving it in the long-lived .env.
JWT_SECRET=$(openssl rand -hex 32)

cat > .env <<EOF
PORT=3000
HOST=0.0.0.0

# Admin username (password is in bootstrap.env, deleted after first start)
PPVDA_ADMIN_USERNAME=${ADMIN_USER}

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

# Darkreel uploads (in-process sealed-box client, no external binary)
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

# Write admin password to a separate bootstrap file (deleted after first start).
# This avoids leaving the plaintext password in the long-lived .env file.
BOOTSTRAP_FILE="${REPO_DIR}/bootstrap.env"
echo "PPVDA_ADMIN_PASSWORD=${ADMIN_PASS}" > "$BOOTSTRAP_FILE"
chmod 600 "$BOOTSTRAP_FILE"

# Add Mullvad config if provided
if [ -n "$MULLVAD_ACCOUNT" ]; then
  cat >> .env <<EOF

# Mullvad VPN
MULLVAD_ACCOUNT=${MULLVAD_ACCOUNT}
MULLVAD_LOCATION=${MULLVAD_LOCATION}
EOF

  # Add Darkreel URL as VPN bypass host (so uploads don't go through VPN)
  if [ -n "$DARKREEL_URL" ]; then
    BYPASS_HOST=$(echo "$DARKREEL_URL" | sed -E 's|https?://||' | sed 's|/.*||' | sed 's|:.*||')
    echo "VPN_BYPASS_HOSTS=${BYPASS_HOST}" >> .env
  else
    echo "VPN_BYPASS_HOSTS=" >> .env
  fi
fi

chmod 600 .env
info ".env generated with secure JWT secret (mode 600)"

# ============================================================
# CADDY (REVERSE PROXY + TLS)
# ============================================================

# Caddy is now installed unconditionally, not just when a domain is given.
#
# The container binds 127.0.0.1:3000 (docker-compose.yml), so Caddy is the
# ONLY path to the app. Previously the container published 0.0.0.0:3000 and
# we relied on UFW to keep it private — but Docker's iptables rules live in
# the DOCKER chain, which is traversed *before* UFW's filter rules, so a
# published port bypasses UFW entirely. On a domain-less install the setup
# script even printed http://<public-ip>:3000 as the access URL, i.e. the
# login endpoint (which receives the plaintext password) was reachable over
# unencrypted HTTP from anywhere.
#
# With a domain: Caddy terminates TLS via Let's Encrypt as before.
# Without one: Caddy serves plain HTTP on :80, which UFW *does* govern.
# That is not encrypted — same as the old behavior — but the port is now
# firewall-controlled and there is a single place to add TLS later.
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

# Site address: the domain (Caddy auto-provisions TLS) or :80 for the
# domain-less install.
if [ -n "$DOMAIN" ]; then
  CADDY_SITE="${DOMAIN}"
else
  CADDY_SITE=":80"
fi

if [ "$DISABLE_ACCESS_LOGS" = "y" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
${CADDY_SITE} {
    reverse_proxy localhost:3000
    log {
        output discard
    }
}
EOF
  LOG_NOTE="access logs disabled for privacy"
else
  cat > /etc/caddy/Caddyfile <<EOF
${CADDY_SITE} {
    reverse_proxy localhost:3000
}
EOF
  LOG_NOTE="access logs enabled"
fi

if [ -n "$DOMAIN" ]; then
  info "Caddy configured for $DOMAIN (HTTPS, $LOG_NOTE)"
else
  warn "No domain given — Caddy is serving plain HTTP on :80 (no TLS, $LOG_NOTE)."
  warn "Credentials will cross the network unencrypted. Re-run with a domain, or put this host behind a VPN/SSH tunnel."
fi
systemctl restart caddy

# ============================================================
# DATABASE BACKUPS (daily, encrypted, 30-day retention)
# ============================================================

mkdir -p "${REPO_DIR}/backups"
chmod 700 "${REPO_DIR}/backups"

BACKUP_KEY_FILE="${REPO_DIR}/backup.key"
if [ ! -f "$BACKUP_KEY_FILE" ]; then
  openssl rand -hex 32 > "$BACKUP_KEY_FILE"
  chmod 600 "$BACKUP_KEY_FILE"
  info "Backup encryption key generated at $BACKUP_KEY_FILE"
  warn "Back up this key separately — without it, encrypted backups cannot be restored."
fi

# Install sqlite3 for hot backups (small package, needed on host)
if ! command -v sqlite3 &>/dev/null; then
  apt-get install -y -qq sqlite3 >/dev/null
fi

cat > /etc/cron.d/ppvda-backup <<'CRONEOF'
# Daily PPVDA database backup at 3 AM, encrypted, 30-day retention
0 3 * * * root /bin/bash -c 'BACKUP_TMP=$(mktemp) && sqlite3 REPODIR/data/ppvda.db ".backup $BACKUP_TMP" && openssl enc -aes-256-cbc -salt -pbkdf2 -in "$BACKUP_TMP" -out "REPODIR/backups/ppvda-$(date +\%Y\%m\%d).db.enc" -pass file:REPODIR/backup.key && rm -f "$BACKUP_TMP" && find REPODIR/backups -name "ppvda-*.db.enc" -mtime +30 -delete'
CRONEOF
sed -i "s|REPODIR|${REPO_DIR}|g" /etc/cron.d/ppvda-backup
info "Daily encrypted database backup configured (3 AM, 30-day retention)"

# ============================================================
# AUTO-UPDATES (optional)
# ============================================================

if [ "$AUTO_UPDATE" = "y" ] || [ "$AUTO_UPDATE" = "Y" ]; then
  if [ -f "${REPO_DIR}/update.sh" ]; then
    chmod +x "${REPO_DIR}/update.sh"
    "${REPO_DIR}/update.sh" --install
  else
    warn "update.sh not found in repo — skipping auto-update setup"
  fi
fi

# ============================================================
# BUILD AND START
# ============================================================

# Merge bootstrap.env into docker compose environment
# by adding it as an env_file in the compose override
if [ -f "$BOOTSTRAP_FILE" ]; then
  cat > docker-compose.override.yml <<EOF
services:
  ppvda:
    env_file:
      - .env
      - bootstrap.env
EOF
fi

info "Building and starting PPVDA (this takes a few minutes on first run)..."
docker compose up --build -d

wait_healthy() {
  local i
  for i in $(seq 1 "$1"); do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# The admin password reaches the container as an environment variable, so it
# is part of that container's configuration (`docker inspect`,
# /var/lib/docker/containers/<id>/config.v2.json) for as long as the container
# exists — shredding bootstrap.env alone doesn't remove it, and while the
# override file exists every `docker compose up` re-applies it. Once the
# admin account exists: shred the file, drop the override, and recreate the
# container from .env alone.
BOOTSTRAP_CLEANUP="cd $(printf '%q' "$REPO_DIR") && { shred -u bootstrap.env 2>/dev/null || rm -f bootstrap.env; } && rm -f docker-compose.override.yml && docker compose up -d --force-recreate"
RC_FILE="${REPO_DIR}/data/admin-recovery-code.txt"

info "Waiting for PPVDA to start..."
HEALTHY="n"
wait_healthy 60 && HEALTHY="y"

if [ -f "$BOOTSTRAP_FILE" ]; then
  # The recovery-code file is written right after the admin account is
  # created — before the VPN comes up — so it also tells us bootstrap is
  # done when a later step (e.g. Mullvad) keeps the app from going healthy.
  if [ "$HEALTHY" = "y" ] || [ -f "$RC_FILE" ]; then
    info "Removing bootstrap credentials and recreating the container without them..."
    if bash -c "$BOOTSTRAP_CLEANUP" >/dev/null 2>&1; then
      info "Bootstrap credentials removed (password stored as hash in DB, gone from the container config)"
    else
      warn "Could not recreate the container. The admin password is still in its config until you run:"
      warn "  $BOOTSTRAP_CLEANUP"
    fi
    if [ "$HEALTHY" = "y" ]; then
      wait_healthy 60 || HEALTHY="n"
    fi
  else
    # Not bootstrapped yet. Finish the cleanup in the background as soon as
    # it is (checked every 30 s for 24 h) rather than leaving the password
    # in bootstrap.env and the container config indefinitely.
    nohup setsid bash -c "for i in \$(seq 1 2880); do if [ -f $(printf '%q' "$RC_FILE") ] || curl -sf http://localhost:3000/health >/dev/null 2>&1; then $BOOTSTRAP_CLEANUP; exit; fi; sleep 30; done" \
      >/var/log/ppvda-bootstrap-cleanup.log 2>&1 < /dev/null &
    echo ""
    warn "${BOLD}PPVDA has not created the admin account yet — the admin password is still in${NC}"
    warn "${BOLD}${BOOTSTRAP_FILE} and in the container's configuration (docker inspect).${NC}"
    warn "A background job removes it once the account exists (log: /var/log/ppvda-bootstrap-cleanup.log)."
    warn "If you fix the problem later, or stop the job, remove it yourself:"
    warn "  $BOOTSTRAP_CLEANUP"
  fi
fi

if [ "$HEALTHY" = "y" ]; then
  echo ""
  echo -e "${GREEN}${BOLD}PPVDA is running!${NC}"
  echo ""
  if [ -n "$DOMAIN" ]; then
    echo -e "  ${BOLD}URL:${NC}       https://${DOMAIN}"
  else
    # Port 80 via Caddy, not 3000 — the container is loopback-bound now.
    echo -e "  ${BOLD}URL:${NC}       http://$(hostname -I | awk '{print $1}')"
  fi
  echo -e "  ${BOLD}Username:${NC}  ${ADMIN_USER}"
  echo ""

  # Read recovery code from the data directory
  if [ -f "$RC_FILE" ]; then
    RC=$(cat "$RC_FILE")
    echo -e "  ${YELLOW}${BOLD}RECOVERY CODE:${NC}"
    echo -e "  ${BOLD}${RC}${NC}"
    echo ""
    echo -e "  ${YELLOW}Save this code somewhere safe — it is the only way to regain${NC}"
    echo -e "  ${YELLOW}access if you forget your password.${NC}"
    echo ""

    # Securely delete the recovery code file
    shred -u "$RC_FILE" 2>/dev/null || rm -f "$RC_FILE"
    info "Recovery code file deleted"
    echo ""
  fi

  if [ -n "$DARKREEL_URL" ]; then
    echo -e "  ${BOLD}Next step:${NC} Log in, go to Settings, and enter your Darkreel"
    echo -e "  credentials (${DARKREEL_URL}) to enable encrypted uploads."
  else
    echo -e "  ${BOLD}Next step:${NC} Log in and paste a video URL to get started."
    echo -e "  To enable encrypted storage, set up a Darkreel server and"
    echo -e "  configure it in Settings."
  fi
  echo ""
  echo -e "  ${BOLD}What was set up:${NC}"
  echo "    - System updates applied"
  echo "    - UFW firewall (SSH, HTTP, HTTPS only)"
  echo "    - fail2ban (auto-bans brute force SSH attempts)"
  echo "    - Automatic security updates"
  [ -n "$DOMAIN" ] && echo "    - Caddy reverse proxy with automatic TLS"
  [ "$DISABLE_ACCESS_LOGS" = "y" ] && [ -n "$DOMAIN" ] && echo "    - Caddy access logs disabled for privacy"
  echo "    - Daily encrypted database backups (${REPO_DIR}/backups/)"
  [ -n "$MULLVAD_ACCOUNT" ] && echo "    - Mullvad VPN (${MULLVAD_LOCATION})"
  [ -n "$SSH_USER" ] && echo "    - SSH user '$SSH_USER' with sudo access"
  [ -n "$SSH_USER" ] && echo "    - Root SSH login disabled"
  [ "$AUTO_UPDATE" = "y" ] || [ "$AUTO_UPDATE" = "Y" ] && echo "    - Auto-updates to new signed release tags (daily at 4 AM)"
  echo ""
  echo "  Useful commands:"
  echo "    docker compose logs -f        # follow logs"
  echo "    docker compose restart        # restart"
  echo "    docker compose down           # stop"
  echo "    docker compose up --build -d  # rebuild after updates"
  [ -n "$SSH_USER" ] && echo "    ssh ${SSH_USER}@${SERVER_IP:-your-server}       # SSH in"
  echo ""
  echo -e "  ${BOLD}Backup key:${NC} ${REPO_DIR}/backup.key"
  warn "Back up this key separately — encrypted backups cannot be restored without it."
  echo ""
else
  warn "PPVDA did not become healthy within 2 minutes."
  echo "  Check status: docker compose logs -f"
  if [ -f "$RC_FILE" ]; then
    echo "  Your admin recovery code is in ${RC_FILE} — read it, save it elsewhere, then delete the file."
  fi
fi
