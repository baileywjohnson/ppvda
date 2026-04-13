#!/usr/bin/env bash
#
# PPVDA quickstart — sets up PPVDA on a fresh Linux VPS with Docker.
#
# What this script does:
#   1. Applies system updates and installs security tooling
#   2. Configures UFW firewall (SSH, HTTP, HTTPS only)
#   3. Installs fail2ban and enables automatic security updates
#   4. Optionally creates a personal SSH user and disables root login
#   5. Installs Docker and Docker Compose (if not present)
#   6. Clones the repo (or uses the current directory)
#   7. Generates a secure .env configuration
#   8. Optionally configures Mullvad VPN
#   9. Sets up Caddy for automatic HTTPS (with optional access log privacy)
#   10. Sets up daily encrypted database backups
#   11. Builds and starts everything with docker compose
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

echo ""
info "Admin user:  $ADMIN_USER"
[ -n "$DOMAIN" ]           && info "Domain:      $DOMAIN"
[ -n "$MULLVAD_ACCOUNT" ]  && info "Mullvad:     $MULLVAD_LOCATION"
[ -n "$DARKREEL_URL" ]     && info "Darkreel:    $DARKREEL_URL"
[ -n "$SSH_USER" ]         && info "SSH user:    $SSH_USER"
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
# DOCKER & PPVDA INSTALLATION
# ============================================================

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

chmod 600 .env
info ".env generated with secure JWT secret (mode 600)"

# ============================================================
# CADDY (REVERSE PROXY + TLS)
# ============================================================

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

  if [ "$DISABLE_ACCESS_LOGS" = "y" ]; then
    cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:3000
    log {
        output discard
    }
}
EOF
    info "Caddy configured for $DOMAIN (HTTPS, access logs disabled for privacy)"
  else
    cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:3000
}
EOF
    info "Caddy configured for $DOMAIN (HTTPS, access logs enabled)"
  fi
  systemctl restart caddy
fi

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

info "Waiting for PPVDA to start..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
  # Bootstrap succeeded — delete the one-time bootstrap file and override
  if [ -f "$BOOTSTRAP_FILE" ]; then
    shred -u "$BOOTSTRAP_FILE" 2>/dev/null || rm -f "$BOOTSTRAP_FILE"
    rm -f docker-compose.override.yml
    info "Bootstrap credentials removed (password stored as hash in DB)"
  fi

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

  # Read recovery code from the data directory
  RC_FILE="${REPO_DIR}/data/admin-recovery-code.txt"
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
  warn "PPVDA may still be starting (Chromium install takes time)."
  echo "  Check status: docker compose logs -f"
fi
