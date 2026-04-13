# PPVDA -- Pretty Private Video Download Assistant

A privacy-focused video extraction and download service. Paste a URL, extract video sources from the page via headless Chromium, download through a VPN or proxy, and optionally encrypt and store in [Darkreel](https://github.com/baileywjohnson/darkreel).

## Features

- **Web UI** -- Paste a URL, see extracted videos, download to your browser or upload to Darkreel
- **Progressive extraction** -- Video sources stream to the UI as they're discovered via Server-Sent Events (~2-3 seconds for first results)
- **Video metadata** -- Duration, resolution, and file size probed in real time via ffprobe
- **Streaming download** -- Videos pipe through ffmpeg directly to your browser. No temp files on the server, and the downloaded file has a different hash from the original.
- **Ad filtering** -- Built-in blocklist of ~30 ad-tech domains, plus size/duration filtering
- **Darkreel integration** -- Background jobs: download, encrypt via [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli), upload to your encrypted library, delete local file
- **Mullvad VPN** -- Built-in WireGuard tunnel. All extraction and download traffic routes through Mullvad with country switching from the admin panel.
- **Proxy support** -- Route traffic through SOCKS4/5 or HTTP/HTTPS proxies as an alternative to Mullvad
- **Multi-user** -- Self-registration (admin-toggleable) or admin-managed user creation. Each user gets an independent master key and configures their own Darkreel credentials.
- **Account recovery** -- Recovery codes generated on registration and password change. The only way to recover an account if the password is forgotten.
- **Encrypted credential storage** -- Darkreel server/username/password encrypted at rest with AES-256-GCM, per-user master keys with AAD binding
- **Host filtering** -- Allow, block, or prioritize videos from specific domains
- **Concurrency control** -- Configurable limits on parallel downloads and extractions
- **Privacy by design** -- No request logging, no URL retention, no download history. Downloaded files are auto-deleted. Job metadata is cleared on completion.

## Architecture

```
Browser --> PPVDA (extract + download) --> Darkreel (encrypted storage + streaming)
              |                                |
   headless Chromium                     darkreel-cli encrypts
   via Mullvad VPN/proxy                 before upload
```

Typical setup: PPVDA runs on a privacy-friendly VPS behind a VPN. Darkreel runs wherever you want fast streaming (e.g., a US or EU VPS). The two servers don't need to be co-located -- darkreel-cli handles the encrypted upload over HTTPS.

## Quick start (VPS with Docker)

Point a domain's DNS A record at your server (optional, for HTTPS), then:

```bash
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
sudo ./setup.sh
```

The script installs Docker, downloads darkreel-cli, generates a secure `.env`, optionally configures Mullvad VPN and Caddy for HTTPS, and starts everything. You'll be prompted for your admin password and optional Mullvad/Darkreel details. Takes about 5 minutes on a fresh Ubuntu/Debian VPS.

When it's done:

1. Open `https://your-domain.com` (or `http://server-ip:3000`) and log in
2. **Save the recovery code** shown in the server logs -- it's the only way to recover your admin account
3. Go to **Settings** and enter your Darkreel server URL, username, and password to enable encrypted uploads
4. Paste a video URL and click **Extract**

### What the script sets up

- Docker container with Chromium, ffmpeg, WireGuard tools, and darkreel-cli
- Persistent volumes for database, downloads, and VPN config
- Caddy reverse proxy with automatic Let's Encrypt TLS (if domain provided)
- Mullvad WireGuard tunnel (if account number provided)
- Secure random JWT secret for persistent sessions across restarts

## Quick start (manual Docker)

```bash
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
cp .env.example .env
```

Edit `.env`:

```bash
PPVDA_ADMIN_PASSWORD=YourStr0ng!Password    # required
JWT_SECRET=$(openssl rand -hex 32)          # recommended for persistent sessions

# Optional: Mullvad VPN
MULLVAD_ACCOUNT=your-account-number
MULLVAD_LOCATION=se
```

```bash
docker compose up --build -d
```

Open `http://localhost:3000` and log in. The container includes ffmpeg, Chromium, and WireGuard tools.

### VPN setup

The Docker container runs with `privileged: true` and `/dev/net/tun` for WireGuard. When a Mullvad account is configured, PPVDA:

1. Generates fresh WireGuard keys on every startup (nothing persisted to disk)
2. Registers a device with the Mullvad API
3. Brings up a WireGuard tunnel routing all traffic through the selected country
4. On shutdown, deregisters the device from Mullvad

If your Darkreel server is on a different host, add it to `VPN_BYPASS_HOSTS` so uploads go direct:

```bash
VPN_BYPASS_HOSTS=media.example.com
```

Admins can switch VPN countries and manage per-user VPN permissions from the admin panel without restarting the container.

## Quick start (without Docker)

### Prerequisites

- Node.js 20+
- ffmpeg
- Chromium (installed via Playwright: `npx playwright install chromium`)

```bash
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
npm install
npx playwright install chromium
cp .env.example .env
# Edit .env — set PPVDA_ADMIN_PASSWORD at minimum
npm run dev
```

## Full deployment example

### 1. Darkreel on a streaming VPS

```bash
# On your streaming server (e.g., US/EU VPS)
git clone https://github.com/baileywjohnson/darkreel.git
cd darkreel
sudo ./setup.sh
# Follow prompts — sets up Darkreel at https://media.example.com
```

### 2. PPVDA on a download VPS

```bash
# On your download server (e.g., privacy-friendly VPS)
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
sudo ./setup.sh
# Follow prompts — enter your Mullvad account and Darkreel URL
```

### 3. Connect them

1. Log in to PPVDA at `https://download.example.com`
2. Go to **Settings**, enter your Darkreel URL, username, and password
3. Credentials are encrypted and stored locally -- PPVDA can't read them without your login session

### 4. Use it

1. Paste a video page URL and click **Extract**
2. Video cards appear progressively with type, quality, duration, and size tags
3. Click **Download** to save to your browser (streamed through ffmpeg, hash modified)
4. Click **Upload to Darkreel** to encrypt and store in your library
5. Stream your encrypted video from `https://media.example.com`

## Web UI workflow

1. **Login** -- Username/password, JWT stored in httpOnly cookie
2. **Paste URL** -- Click Extract to discover video sources via headless Chromium
3. **Progressive results** -- Video cards appear as they're found. Metadata (duration, resolution, size) loads progressively via ffprobe.
4. **Ad filtering** -- Tiny files and very short clips are separated into a collapsed "Possible ads" section
5. **Download** -- Streams video through ffmpeg directly to your browser (no server temp file, hash modified)
6. **Upload to Darkreel** -- Submits a background job: download, encrypt, upload, delete local file

## Privacy and security

### What the server retains

| Data | Retained? | Notes |
|------|-----------|-------|
| Video URLs | No | Only in browser memory during extraction |
| Downloaded files | No | Securely overwritten and deleted after job completion |
| Download history | No | Job metadata cleared from memory when jobs finish |
| Darkreel credentials | Encrypted at rest | AES-256-GCM, per-user master key with AAD binding |
| Usernames | Yes (plaintext) | Use non-identifying usernames |
| Passwords | Hashed (Argon2id) | Separate auth salt per user (t=3, m=64MB, p=4) |
| Master keys | Encrypted at rest | Encrypted with password-derived key + recovery code |

### Security measures

- **TLS required** -- PPVDA does not handle TLS. Deploy behind a reverse proxy or access over a secure tunnel only.
- **Argon2id password hashing** -- Memory-hard hashing with parameters matching Darkreel (t=3, m=64MB, p=4, keyLen=32). Dual salts: separate auth salt for password hash and KDF salt for master key encryption.
- **Authenticated encryption** -- All master key encryption uses AES-256-GCM with Additional Authenticated Data (AAD) binding encrypted keys to their owner's user ID, preventing ciphertext substitution between users.
- **Recovery codes** -- 32-byte random codes generated on registration and rotated on every password change. Master key is independently encrypted with the recovery code. Recovery codes are written to a file (mode 0600) on first run -- never printed to stdout where container orchestration could capture them.
- **Timing-safe authentication** -- Dummy Argon2id derivation performed for non-existent usernames, preventing timing-based username enumeration.
- **Per-username rate limiting** -- 10 login/recovery attempts per username per 15 minutes, defending against distributed brute-force even when per-IP limits are bypassed.
- **Session isolation** -- Sessions indexed by random session ID (not user ID), with session ID embedded in JWT. Password changes and recovery invalidate all existing sessions.
- **SSRF protection** -- All user-provided URLs are validated against private IP ranges, IPv6 loopback/link-local/unique-local, and IPv4-mapped IPv6 addresses. DNS resolution is checked twice to detect rebinding attacks. DNS failures are rejected (fail-closed). HTTP redirect targets are re-validated before following. Darkreel server URLs are validated before connection tests.
- **No shell injection** -- All subprocesses (ffmpeg, darkreel-cli) are spawned with argument arrays, never through a shell. Credentials are passed via environment variables.
- **Admin re-verification** -- Admin status is verified from the database on every privileged request. Revoking admin access takes effect immediately, not after JWT expiry.
- **Rate limiting** -- 100 requests/min globally, 5/min on login/register/recover endpoints.
- **Concurrency limits** -- Max 3 concurrent Playwright extractions and 3 concurrent downloads (configurable).
- **Cookie security** -- httpOnly, SameSite=strict, Secure in production. No tokens in localStorage or query parameters.
- **Minimal subprocess environment** -- ffmpeg and darkreel-cli receive only PATH, HOME, and TMPDIR. Secrets like JWT_SECRET and MULLVAD_ACCOUNT are not leaked.
- **Security headers** -- CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy on all responses.
- **VPN bypass validation** -- Hostnames and IPs in `VPN_BYPASS_HOSTS` are validated before writing to system routes and `/etc/hosts`, preventing injection of arbitrary entries.
- **No request logging** -- URLs never appear in server logs. No persistent audit logs -- rate limiting and session state are in-memory only and cleared on restart.
- **Coarsened timestamps** -- Database timestamps use year-week precision (`strftime('%Y-%W')`) matching Darkreel's approach, preventing precise activity correlation. In-memory job timestamps are rounded to the minute.
- **Secure file deletion** -- Downloaded media files are overwritten with random data and fsynced before unlinking, preventing forensic recovery of content from disk.
- **WAL hygiene** -- SQLite WAL files are checkpointed and truncated every 5 minutes and on shutdown, preventing forensic recovery of past database transactions.
- **DNS privacy** -- When Mullvad VPN is active, DNS queries are routed through the WireGuard tunnel (`hijack_dns: true`), preventing ISP-visible DNS leaks for extracted video domains.
- **Memory security** -- Master keys, derived keys, and passwords are zeroed from memory immediately after use. Session cleanup runs every 60 seconds to evict expired sessions.

### Credential encryption model

```
                  ┌─── Argon2id(password, auth_salt) ──> password_hash (authentication)
User Password ────┤
                  └─── Argon2id(password, kdf_salt) ──> kdf_key
                                                           |
                                  Decrypts: encrypted_master_key (AES-256-GCM, AAD=userID)
                                                           |
                                                       master_key (RAM only)
                                                           |
                                  Decrypts: darkreel_creds (AES-256-GCM, per-user, in DB)

Recovery Code ──> Decrypts: recovery_mk (AES-256-GCM, AAD=userID) ──> master_key
```

- Database stolen? Encrypted blobs are useless without a user's password or recovery code.
- Server compromised? Attacker cannot retroactively decrypt stored credentials.
- Server restarted? All sessions cleared, users must re-login.
- Forgot password? Recovery code decrypts the master key, allowing a full password reset.

### VPN privacy

- Fresh WireGuard keys generated on every startup -- no persistent cryptographic material on disk
- Device deregistered from Mullvad on clean shutdown
- All extraction and download traffic routes through the tunnel, including DNS
- Darkreel uploads can bypass the VPN via `VPN_BYPASS_HOSTS` (direct connection for speed)

### Password requirements

- 16-128 characters
- Must contain at least one letter, one number, and one symbol
- No whitespace allowed

## User management

### Admin bootstrap

On first startup, if the database is empty, PPVDA creates an admin user from `PPVDA_ADMIN_USERNAME` and `PPVDA_ADMIN_PASSWORD`. The recovery code is written to `<DB_PATH_DIR>/admin-recovery-code.txt` (mode 0600) -- read it, save it, then delete the file. After this, the env vars are not used for authentication -- the database is authoritative.

### Self-registration

Admins can enable self-registration from the **Admin** panel. When enabled, a **Register** tab appears on the login page. New users receive a recovery code on registration that must be saved immediately. Registration is disabled by default.

### Creating users (admin)

Admins can create users via the **Admin** panel in the web UI or the API:

```bash
curl -X POST https://your-domain.com/admin/users \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"username": "alice", "password": "SecureP@ssw0rd123"}'
```

The response includes a `recovery_code` that must be given to the user.

### Account recovery

If a user forgets their password, they can reset it using their recovery code via the **Forgot password?** link on the login page. Recovery codes are rotated on every password change and recovery -- the old code is invalidated and a new one is displayed.

## Darkreel integration

Each user configures their own Darkreel credentials in **Settings**. Credentials are validated (test login) before being saved and encrypted at rest.

The upload pipeline: **download --> encrypt (darkreel-cli) --> upload to Darkreel --> delete local file**. Credentials are passed to darkreel-cli via environment variables (never CLI arguments).

To set up the integration:

1. Deploy a [Darkreel](https://github.com/baileywjohnson/darkreel) server
2. Ensure `darkreel-cli` is available (included in the Docker image, or [install manually](https://github.com/baileywjohnson/darkreel-cli#install))
3. In PPVDA, go to **Settings** and enter your Darkreel server URL, username, and password

## Configuration

All configuration is via environment variables (or `.env` file).

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `DOWNLOAD_DIR` | `./downloads` | Temp directory (files auto-deleted after jobs) |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max parallel download/upload jobs |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `PPVDA_ADMIN_USERNAME` | `admin` | Admin username (first-run only) |
| `PPVDA_ADMIN_PASSWORD` | **(required)** | Admin password (first-run only) |
| `JWT_SECRET` | random (dev), **required** (prod) | JWT signing secret. Required when `NODE_ENV=production`. Set to a random 32+ character string for persistent sessions across restarts. |
| `DB_PATH` | `./data/ppvda.db` | SQLite database path |

### Darkreel CLI

| Variable | Default | Description |
|----------|---------|-------------|
| `DRK_BINARY_PATH` | `darkreel-cli` | Path to darkreel-cli binary |
| `DRK_UPLOAD_TIMEOUT_MS` | `600000` | Upload timeout (10 min) |

### Extraction and download

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_TIMEOUT_MS` | `30000` | Page load timeout |
| `NETWORK_IDLE_MS` | `2000` | Wait for network idle before finishing extraction |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Download timeout (5 min) |

### Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | | Proxy URL (e.g., `socks5://user:pass@host:port`) |

### Host filtering

Comma-separated domain lists with subdomain matching.

| Variable | Description |
|----------|-------------|
| `PREFERRED_HOSTS` | Videos from these domains are sorted first |
| `BLOCKED_HOSTS` | Videos from these domains are excluded |
| `ALLOWED_HOSTS` | When set, only videos from these domains are returned |

### Mullvad VPN

| Variable | Description |
|----------|-------------|
| `MULLVAD_ACCOUNT` | Mullvad account number |
| `MULLVAD_LOCATION` | Country code (`se`) or country-city (`se-mma`, `us-nyc`) |
| `MULLVAD_CONFIG_DIR` | WireGuard config directory (default: `./mullvad`) |
| `VPN_BYPASS_HOSTS` | Comma-separated hostnames to route outside the VPN |

### Features

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_THUMBNAILS` | `false` | Video thumbnail previews in extraction results |
| `MAX_JOB_HISTORY` | `100` | Completed jobs kept in memory |

## API

All endpoints except `/health`, `/auth/login`, `/auth/register`, `/auth/recover`, and `/auth/registration` require authentication.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login (returns JWT, sets httpOnly cookie) |
| POST | `/auth/register` | Self-registration (when enabled by admin) |
| POST | `/auth/recover` | Reset password with recovery code |
| GET | `/auth/registration` | Check if self-registration is enabled |
| POST | `/auth/logout` | Logout (clears session and cookie) |
| POST | `/auth/change-password` | Change password (returns new recovery code) |
| DELETE | `/auth/account` | Delete your account |

### Extraction

| Method | Path | Description |
|--------|------|-------------|
| POST | `/extract` | Extract video sources (returns full list) |
| POST | `/extract/stream` | Extract with progressive SSE streaming |

### Download

| Method | Path | Description |
|--------|------|-------------|
| POST | `/stream-download` | Stream video through ffmpeg to browser |
| POST | `/download` | Download video to server disk |

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Submit download + Darkreel upload job |
| GET | `/jobs` | List your jobs |
| GET | `/jobs/:id` | Get job status |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/darkreel` | Check if Darkreel is configured |
| PUT | `/settings/darkreel` | Save Darkreel credentials |
| DELETE | `/settings/darkreel` | Remove Darkreel credentials |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/users` | List users |
| POST | `/admin/users` | Create user (returns recovery code) |
| DELETE | `/admin/users/:id` | Delete user |
| POST | `/admin/registration` | Enable/disable self-registration |
| GET | `/admin/vpn/relays` | List VPN countries/cities |
| POST | `/admin/vpn/switch` | Switch VPN country |
| PUT | `/admin/vpn/default` | Set server-wide VPN default |
| PUT | `/admin/vpn/user-toggle` | Grant/revoke user VPN toggle |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Feature flags and user context |
| GET | `/health` | Health check (no auth) |

## System requirements

### PPVDA server

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 vCPU | 4+ vCPU |
| RAM | 2 GB | 4+ GB |
| Disk | 20 GB | 50+ GB |
| OS | Linux (amd64 or arm64) | Ubuntu 22.04+ / Debian 12+ |

PPVDA is heavier than Darkreel because it runs headless Chromium and ffmpeg. The 2 GB RAM minimum is driven by Chromium.

### Darkreel server

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 1 vCPU | 2+ vCPU |
| RAM | 512 MB | 1+ GB |
| Disk | 10 GB | Depends on library size |

## Related projects

- [Darkreel](https://github.com/baileywjohnson/darkreel) -- E2E encrypted media server
- [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli) -- CLI upload tool for Darkreel

## License

MIT
