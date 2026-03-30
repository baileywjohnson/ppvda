# PPVDA -- Pretty Private Video Download Assistant

A privacy-focused video extraction and download service with a web UI. Extracts video sources from web pages via headless Chromium, downloads them through a proxy or Mullvad VPN, and optionally encrypts and uploads them to a [Darkreel](https://github.com/baileywjohnson/darkreel) server.

## Features

- **Web UI** -- Paste a URL, see extracted videos with metadata, download or upload to Darkreel
- **Progressive extraction** -- Video sources stream to the UI as they're discovered (first results in ~2-3 seconds)
- **Video metadata** -- Duration, resolution, file size probed via ffprobe and displayed as tags
- **Ad filtering** -- Built-in blocklist of ~30 common ad-tech domains
- **Hash modification** -- Downloaded files are remuxed through ffmpeg, producing a different hash from the source
- **Streaming download** -- Videos pipe through ffmpeg directly to your browser with no temp file on the server
- **Multi-user** -- Per-user accounts with admin-managed user creation
- **Encrypted Darkreel credentials** -- Each user's Darkreel server/username/password are encrypted at rest with a hybrid encryption model
- **Configurable thumbnails** -- Optional server-side thumbnail generation via ffmpeg (preserves VPN/proxy routing)
- **Proxy support** -- Route all traffic through SOCKS4/5 or HTTP/HTTPS proxies
- **Mullvad VPN** -- Auto-configures a WireGuard tunnel inside Docker containers
- **Concurrency control** -- Configurable parallel download limit
- **Privacy by design** -- No request logging, no URL retention, no download history, downloaded files auto-deleted

## Architecture

```
Browser  -->  PPVDA (download server)  -->  Darkreel (streaming server)
                |                                |
   paste URL    |  extract + download + encrypt  |  encrypted storage
   view results |  via proxy/VPN                 |  streaming to client
```

PPVDA runs on a server in a privacy-friendly location (behind VPN/proxy). Darkreel runs wherever you want low-latency streaming (e.g., a US VPS). The two communicate through the [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli) tool, which encrypts files locally before uploading.

## Minimum requirements

### PPVDA server

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 vCPU | 4+ vCPU |
| RAM | 2 GB | 4+ GB |
| Disk | 20 GB | 50+ GB |
| OS | Linux (amd64 or arm64) | Ubuntu 22.04+ / Debian 12+ |

PPVDA is more resource-intensive than Darkreel because it runs headless Chromium for video extraction and ffmpeg for downloads/probing. The 2 GB RAM minimum is driven by Chromium.

### Darkreel server

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 1 vCPU | 2+ vCPU |
| RAM | 512 MB | 1+ GB |
| Disk | 10 GB | Depends on library size |

## Security

### TLS required

PPVDA does not handle TLS itself. **You must deploy it behind a TLS-terminating reverse proxy** (nginx, Caddy, etc.) or access it only over a secure tunnel (WireGuard, SSH). Without TLS, login credentials and session cookies are transmitted in plaintext.

### Credential encryption (hybrid model)

Each user's Darkreel credentials are encrypted at rest using a hybrid encryption model:

```
User Password --> PBKDF2 --> user_key
                               |
                   Decrypts: encrypted_master_key (per-user, stored in DB)
                               |
                           master_key (lives in RAM only, never on disk)
                               |
                   Decrypts: darkreel_creds (per-user, stored in DB)
```

- A single `master_key` is generated once at first startup and never stored in plaintext
- Each user stores a copy of `master_key` encrypted with their own password-derived key
- Darkreel credentials are encrypted with `master_key` using AES-256-GCM
- On login, the password unlocks the master key and holds it in RAM
- On server restart, all sessions are cleared -- users must re-login

**Threat model:**
- Database file stolen --> encrypted master keys + encrypted creds --> useless without a user password
- Environment variables stolen --> no master key there --> useless
- Full server compromise --> attacker could modify code, but cannot retroactively decrypt stored creds

### What the server retains

| Data | Retained? | Where |
|------|-----------|-------|
| Video URLs | No | Only in browser memory during extraction |
| Downloaded files | No | Auto-deleted after job completion |
| Download history | No | Job metadata cleared from memory on completion |
| Darkreel credentials | Encrypted at rest | SQLite DB |
| Usernames | Yes (plaintext) | SQLite DB -- use non-identifying usernames |
| Passwords | Hashed (scrypt) | SQLite DB |

### Password hashing

Passwords are hashed with scrypt (N=16384, r=8, p=1, 64-byte output) with a random 32-byte salt per user. The PBKDF2 key derivation for credential encryption uses SHA-256 with 100,000 iterations.

## Quick start

### Prerequisites

- Node.js 20+
- ffmpeg (for downloads, remuxing, and thumbnail generation)
- Chromium (installed via Playwright)

### Setup

```bash
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env` and set your admin password:

```
PPVDA_ADMIN_USERNAME=admin
PPVDA_ADMIN_PASSWORD=your-secure-password
```

### Run

```bash
npm run dev
```

Open `http://localhost:3000`, log in with your admin credentials. On first startup, the admin account is created in the database. After that, the env var password is ignored -- use the password you set (or change it in Settings).

## User management

### Admin bootstrap

On first startup, if the database is empty, PPVDA creates an admin user from the `PPVDA_ADMIN_USERNAME` and `PPVDA_ADMIN_PASSWORD` environment variables. After this, the env vars are not used for authentication -- the database is authoritative.

### Creating users

Only admins can create new users. In the web UI, click **Admin** in the header to access user management. Or use the API:

```bash
curl -X POST http://localhost:3000/admin/users \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "securepass123"}'
```

### Changing password

Any logged-in user can change their own password via **Settings** in the web UI, or:

```bash
curl -X POST http://localhost:3000/auth/change-password \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"oldPassword": "current", "newPassword": "newsecurepass"}'
```

## Darkreel integration

Each user configures their own Darkreel credentials independently via **Settings** in the web UI. Credentials are encrypted at rest (see [Credential encryption](#credential-encryption-hybrid-model)).

1. Set up a [Darkreel](https://github.com/baileywjohnson/darkreel) server and create an account
2. Install [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli#install) on the PPVDA server (make sure it's in PATH or set `DRK_BINARY_PATH`)
3. In the PPVDA web UI, go to **Settings** and enter your Darkreel server URL, username, and password
4. The "Upload to Darkreel" button will now appear on extracted videos

When you click "Upload to Darkreel", the pipeline runs: **download --> encrypt (via darkreel-cli) --> upload to Darkreel --> delete local file**. Credentials are passed to darkreel-cli via environment variables (not CLI args) to prevent exposure in `ps aux`.

## Web UI workflow

1. **Login** -- Username/password, JWT stored in httpOnly cookie
2. **Paste URL** -- Click "Extract" to discover video sources
3. **Progressive results** -- Video cards appear as they're found (~2-3s for first results)
4. **Metadata tags** -- Type (HLS/DASH/DIRECT), quality, duration, file size load progressively via ffprobe
5. **Ad filtering** -- Tiny files (<5KB) and very short videos (<=2s) are moved to a collapsed "Possible ads" section
6. **Download** -- Streams video through ffmpeg remux directly to your browser (no server-side storage, hash modified)
7. **Upload to Darkreel** -- Submits a background job that downloads, encrypts, and uploads to your Darkreel server

## API

All endpoints except `/health` and `/auth/login` require authentication via Bearer token or session cookie.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login, returns JWT + sets cookie |
| POST | `/auth/logout` | Logout, clears session + cookie |
| POST | `/auth/change-password` | Change password (requires `oldPassword` + `newPassword`) |

### Extraction

| Method | Path | Description |
|--------|------|-------------|
| POST | `/extract` | Extract video sources (synchronous, returns full list) |
| POST | `/extract/stream` | Extract with progressive SSE streaming |

### Download

| Method | Path | Description |
|--------|------|-------------|
| POST | `/stream-download` | Stream video through ffmpeg remux to browser (hash modified) |
| POST | `/download` | Download video to server disk (legacy) |

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Submit upload-to-Darkreel job |
| GET | `/jobs` | List your jobs |
| GET | `/jobs/:id` | Get job status |

### Thumbnails

| Method | Path | Description |
|--------|------|-------------|
| GET | `/thumbnail?videoUrl=<url>` | Generate thumbnail via ffprobe (only if `ENABLE_THUMBNAILS=true`) |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/darkreel` | Check if Darkreel credentials are configured |
| PUT | `/settings/darkreel` | Save Darkreel credentials (encrypted at rest) |
| DELETE | `/settings/darkreel` | Remove Darkreel credentials |

### Admin (admin-only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/users` | List all users |
| POST | `/admin/users` | Create a new user |
| DELETE | `/admin/users/:id` | Delete a user (immediately invalidates their session) |

### Config

| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Get feature flags (thumbnails enabled, Darkreel configured, admin status) |
| GET | `/health` | Health check (no auth required) |

## Configuration

All configuration is via environment variables (or `.env` file).

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `DOWNLOAD_DIR` | `./downloads` | Temp directory for downloads (files auto-deleted after jobs) |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary (ffprobe derived from this) |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max parallel download/upload jobs |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `PPVDA_ADMIN_USERNAME` | `admin` | Admin username (first-run bootstrap only) |
| `PPVDA_ADMIN_PASSWORD` | **(required on first run)** | Admin password (first-run bootstrap only) |
| `JWT_SECRET` | random UUID | JWT signing secret (random per restart if not set -- set this for persistent sessions) |
| `DB_PATH` | `./data/ppvda.db` | SQLite database path |

### Darkreel CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `DRK_BINARY_PATH` | `darkreel-cli` | Path to the darkreel-cli binary |
| `DRK_UPLOAD_TIMEOUT_MS` | `600000` | Max time for darkreel-cli upload (10 min) |

### Extraction & Download

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_TIMEOUT_MS` | `30000` | Max time to wait for page load |
| `NETWORK_IDLE_MS` | `2000` | Wait for network idle before finishing extraction |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Max time for a video download (5 min) |

### Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | | Proxy URL (e.g., `socks5://user:pass@host:port`) |

### Host filtering

Comma-separated domain lists. Subdomain matching is supported.

| Variable | Description |
|----------|-------------|
| `PREFERRED_HOSTS` | Videos from these domains are sorted first |
| `BLOCKED_HOSTS` | Videos from these domains are excluded |
| `ALLOWED_HOSTS` | When set, **only** videos from these domains are returned |

### Mullvad VPN

For use in Docker. Sets up a WireGuard tunnel so all container traffic routes through Mullvad.

| Variable | Description |
|----------|-------------|
| `MULLVAD_ACCOUNT` | Mullvad account number |
| `MULLVAD_LOCATION` | Relay location -- country code (`se`) or country-city (`se-mma`, `us-nyc`) |
| `MULLVAD_CONFIG_DIR` | WireGuard config directory (default: `./mullvad`) |

### Features

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_THUMBNAILS` | `false` | Enable video thumbnail previews in extraction results |
| `MAX_JOB_HISTORY` | `100` | Max completed jobs kept in memory |

## Docker

The Docker image includes ffmpeg, Chromium, WireGuard tools, and downloads the latest `darkreel-cli` binary automatically.

```bash
# Build and run
docker compose up --build

# Pin a specific darkreel-cli version
docker build --build-arg DARKREEL_CLI_VERSION=v1.0.0 -t ppvda .
```

### docker-compose.yml

Set your environment variables in `.env`:

```bash
# Required
PPVDA_ADMIN_PASSWORD=your-secure-password

# Recommended: set a persistent JWT secret
JWT_SECRET=your-random-256-bit-hex-string

# Optional: Mullvad VPN
MULLVAD_ACCOUNT=your-account-number
MULLVAD_LOCATION=se-mma
```

The container requires `NET_ADMIN` capability and `/dev/net/tun` for WireGuard (already configured in `docker-compose.yml`).

## Full deployment example

### 1. Darkreel on a US VPS (streaming)

```bash
# On your US VPS
git clone https://github.com/baileywjohnson/darkreel.git
cd darkreel
go build -o darkreel .
./darkreel -addr :8080 -data /var/lib/darkreel
# Set up nginx reverse proxy with TLS (see Darkreel README)
```

Register an account via the web UI at `https://media.example.com`.

### 2. PPVDA on a download server (with VPN)

```bash
# On your download server
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda

# Install darkreel-cli
curl -fSL -o /usr/local/bin/darkreel-cli \
  https://github.com/baileywjohnson/darkreel-cli/releases/latest/download/darkreel-cli-linux-amd64
chmod +x /usr/local/bin/darkreel-cli

# Configure
cp .env.example .env
# Edit .env:
#   PPVDA_ADMIN_PASSWORD=your-ppvda-password
#   JWT_SECRET=<generate with: openssl rand -hex 32>

# Run with Docker (includes Mullvad VPN)
docker compose up --build
```

### 3. Configure Darkreel integration

1. Open `http://your-download-server:3000` and login
2. Go to **Settings**
3. Enter your Darkreel server URL, username, and password
4. Save -- credentials are encrypted and stored in the local database

### 4. Use it

1. Paste a video page URL and click "Extract"
2. Video cards appear progressively with metadata tags
3. Click "Download" to save to your browser, or "Upload to Darkreel" to encrypt and store
4. Stream your encrypted video at `https://media.example.com`

## Privacy

- Request logging is disabled -- no URLs appear in server logs
- Extraction results live only in browser memory, never persisted
- Downloaded files are auto-deleted after job completion
- Job metadata (file size, duration, format) is cleared from memory when jobs finish
- Error messages are sanitized to exclude URLs and paths
- Darkreel credentials are encrypted at rest with per-user keys
- The `darkreel-cli` subprocess receives credentials via environment variables, not CLI arguments
- CORS is disabled (same-origin only)
- JWTs contain only user ID and role -- no username

## Related projects

- [Darkreel](https://github.com/baileywjohnson/darkreel) -- E2E encrypted media server
- [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli) -- Command-line upload tool for Darkreel

## License

MIT
