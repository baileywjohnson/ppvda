<p align="center">
  <span style="font-size: 120px;">🎭</span><br>
  <img src="https://em-content.zobj.net/source/apple/391/performing-arts_1f3ad.png" width="120" />
</p>

<h1 align="center">PPVDA</h1>

<p align="center">
  <strong>Pretty Private Video Download Assistant.</strong><br>
  Extract, download, and optionally encrypt video through a VPN — no logs, no history, no trace.
</p>

<p align="center">
  <a href="https://github.com/baileywjohnson/ppvda/stargazers"><img src="https://img.shields.io/github/stars/baileywjohnson/ppvda?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/baileywjohnson/ppvda/commits/main"><img src="https://img.shields.io/github/last-commit/baileywjohnson/ppvda?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/baileywjohnson/ppvda?style=flat" alt="License"></a>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#deploy">Deploy</a> •
  <a href="#privacy--security">Privacy</a> •
  <a href="#api">API</a> •
  <a href="#configuration">Configuration</a>
</p>

---

## Features

- **Web UI** — Paste a URL, see extracted videos, download to your browser or upload to Darkreel
- **Progressive extraction** — Video sources stream to the UI as they're discovered via Server-Sent Events (~2-3 seconds for first results)
- **Video metadata** — Duration, resolution, and file size probed in real time via ffprobe
- **Streaming download** — Videos pipe through ffmpeg directly to your browser. No temp files on the server, and the downloaded file has a different hash from the original
- **Ad filtering** — Built-in blocklist of ~28 ad-tech domains, plus size/duration filtering
- **Darkreel integration** — Background jobs: download, encrypt in-process (X25519 sealed-box to your Darkreel public key), upload to your encrypted library, securely delete local file. PPVDA never holds your Darkreel password — connect once via a copy-paste authorization code and revoke anytime from Darkreel's Connected Apps panel
- **Mullvad VPN** — Built-in WireGuard tunnel. All extraction and download traffic routes through Mullvad with country switching from the admin panel
- **Proxy support** — Route traffic through SOCKS4/5 or HTTP/HTTPS proxies as an alternative to Mullvad
- **Multi-user** — Self-registration (admin-toggleable) or admin-managed user creation. Each user gets an independent master key and configures their own Darkreel credentials
- **Account recovery** — Recovery codes generated on registration and password change. The only way to recover an account if the password is forgotten
- **Delegation-based Darkreel credentials** — PPVDA stores a scoped refresh token + your Darkreel X25519 public key, AES-256-GCM encrypted at rest under each user's master key. No Darkreel password is ever held — a full PPVDA compromise grants upload-only capability, not read/list/delete on existing media
- **Host filtering** — Allow, block, or prioritize videos from specific domains
- **Concurrency control** — Configurable limits on parallel downloads and extractions
- **Image extraction** — Optionally discover and download images alongside videos
- **Auto-play detection** — Clicks play buttons and triggers video playback to discover lazy-loaded sources
- **Privacy by design** — No request logging, no URL retention, no download history. Downloaded files are securely overwritten and deleted. Job metadata is cleared on completion

## Architecture

```
Browser --> PPVDA (extract + download) --> Darkreel (encrypted storage + streaming)
              |                                |
   headless Chromium                     in-process client seals
   via Mullvad VPN/proxy                 per-file keys to user's
                                         X25519 public key
```

Typical setup: PPVDA runs on a privacy-friendly VPS behind a VPN. Darkreel runs wherever you want fast streaming (e.g., a US or EU VPS). The two servers don't need to be co-located — PPVDA's native Darkreel client speaks the schema v2 sealed-box protocol directly, so no external CLI binary is needed.

### Extraction pipeline

1. Playwright launches headless Chromium with stealth patches (masks `navigator.webdriver`, fakes plugins/languages/platform, stubs Chrome runtime)
2. Network interceptor hooks all page responses, classifying URLs by extension (`.m3u8`, `.mpd`, `.mp4`, etc.) and MIME type
3. DOM scanner evaluates in-page JS to find `<video>`, `<source>`, data attributes, JW Player globals, and Video.js instances
4. Auto-play attempts `.play()` on video elements and clicks common play button selectors
5. Videos are deduplicated, ad-filtered, and streamed to the UI as they're discovered
6. ffprobe runs in parallel per video to resolve duration, resolution, and file size

### Download pipeline

| Type | Method |
|------|--------|
| HLS (`.m3u8`) | ffmpeg remux to MP4 |
| DASH (`.mpd`) | ffmpeg remux to MP4 |
| Direct (`.mp4`, `.webm`, etc.) | HTTP fetch |
| Image | Direct HTTP fetch |

Browser downloads use fragmented MP4 (`frag_keyframe+empty_moov`) piped through ffmpeg to stdout — no temp file, modified hash. Disk downloads use `faststart` for optimal playback.

### Job pipeline

```
submit → extract (optional) → download → remux to fMP4 (videos) → seal + encrypt + upload → secure delete
```

For direct-MP4 downloads (plain file URLs, not HLS/DASH), PPVDA runs ffmpeg with `-movflags frag_keyframe+empty_moov+default_base_moof` before upload so Darkreel's MSE player can stream them — without fragmentation, the file uploads as a single chunk and playback stalls after the init segment. Pre-fragmented output from the HLS/DASH path skips the extra remux.

Jobs run with a configurable concurrency semaphore. Each stage updates the job store, which emits events to connected clients. Terminal jobs have sensitive metadata (file path, size, format) cleared from memory.

## Deploy

### One command on a fresh VPS

```bash
git clone https://github.com/baileywjohnson/ppvda.git && cd ppvda
sudo ./setup.sh
```

The script prompts for:

- **Domain name** (optional, for automatic HTTPS via Caddy)
- **Admin password** (16+ chars with letter, number, symbol)
- **Mullvad account** (optional, for WireGuard VPN)
- **Darkreel server URL** (optional, for encrypted uploads)
- **SSH user** (optional, for secure remote access)
- **Access log privacy** (optional, disables Caddy request logs)

Takes about 5 minutes. When it's done you'll see:

- Your login URL
- Your **recovery code** (save it immediately — it's the only way to recover your account)
- A summary of everything that was configured

| Category | Details |
|----------|---------|
| **System hardening** | System updates, automatic security patches (`unattended-upgrades`) |
| **Firewall** | UFW: SSH, HTTP, HTTPS only. All other ports denied. |
| **Brute-force protection** | fail2ban auto-bans repeated SSH failures |
| **SSH hardening** | Optional personal user with sudo, root login disabled |
| **Docker** | Docker + Compose installed and enabled |
| **Application** | PPVDA container with Chromium, ffmpeg, WireGuard |
| **Reverse proxy** | Caddy with automatic Let's Encrypt TLS (if domain provided) |
| **Access log privacy** | Optional: Caddy access logs discarded (no IP/URL logging) |
| **VPN** | Mullvad WireGuard tunnel (if account provided) |
| **Database backups** | Daily encrypted backup at 3 AM (AES-256-CBC, 30-day retention) |
| **Credential security** | Admin password shredded after bootstrap; `.env` is mode 600 |

### Docker (manual)

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

### Without Docker

Prerequisites: Node.js 20+, ffmpeg, Chromium (`npx playwright install chromium`)

```bash
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
npm install
npx playwright install chromium
cp .env.example .env
# Edit .env — set PPVDA_ADMIN_PASSWORD at minimum
npm run dev
```

### VPN setup

The Docker container uses `NET_ADMIN` capability and `/dev/net/tun` for WireGuard. Only the privileged `wg-supervisor` helper exercises those capabilities — the main Node process runs as the unprivileged `ppvda` user and talks to the supervisor over a Unix socket for tunnel operations (see [Privilege split](#privilege-split) below). When a Mullvad account is configured, PPVDA:

1. Generates fresh WireGuard keys on every startup (nothing persisted to disk)
2. Registers a device with the Mullvad API
3. Brings up a WireGuard tunnel routing all traffic through the selected country
4. On shutdown, deregisters the device from Mullvad

If your Darkreel server is on a different host, add it to `VPN_BYPASS_HOSTS` so uploads go direct:

```bash
VPN_BYPASS_HOSTS=media.example.com
```

Admins can switch VPN countries and manage per-user VPN permissions from the admin panel without restarting the container.

### Privilege split

The Node process (and everything it spawns — Playwright, Chromium, ffmpeg, ffprobe) always runs as the unprivileged `ppvda` user, in both the bare and the Mullvad deployments. This lets Chromium's user-namespace sandbox work, so a renderer bug lands in a confined process instead of container root.

In the Mullvad deployment, the operations that genuinely require `CAP_NET_ADMIN` — `wg-quick up`/`down`, `ip route add`, writing `/etc/resolv.conf` and `/etc/hosts` — are handled by a small privileged helper called **`wg-supervisor`**, written in Go (see [`wg-supervisor/`](wg-supervisor/)). The supervisor runs as root and listens on a Unix socket at `/run/ppvda/wg.sock`; the Node process sends length-prefixed JSON RPCs for four fixed operations (`BRINGUP`, `TEARDOWN`, `ADD_ROUTES`, `GATEWAY`). The supervisor authenticates every incoming connection via `SO_PEERCRED` and only accepts peers with the `ppvda` uid. No HTTP, no network listeners, no user input beyond the RPC payload.

What this changes for the threat model: a Chromium renderer RCE (V8 bug, image codec bug, etc. — Chromium gets a couple of these a year) used to land in a root process with `NET_ADMIN` and could defeat the VPN kill-switch, edit `/etc/hosts`, or modify the routing table. Now it lands in an unprivileged process that can still read what the app can read (same uid) but cannot touch network configuration without also escaping Chromium's renderer sandbox *and* the kernel's user namespace.

The bare deployment (no `MULLVAD_ACCOUNT`) doesn't start the supervisor and skips the socket entirely — Node just runs directly as `ppvda` since no privileged ops are needed.

### Backups

The setup script configures daily encrypted database backups:

- **Schedule:** 3 AM daily via cron
- **Encryption:** AES-256-CBC with a randomly generated key
- **Retention:** 30 days (older backups auto-deleted)
- **Key location:** `<repo>/backup.key` — back this up separately

To restore:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in backups/ppvda-20260412.db.enc \
  -out ppvda-restored.db \
  -pass file:backup.key
```

### Upgrading

```bash
cd /opt/ppvda
git pull
docker compose up --build -d
```

Or use the auto-updater:

```bash
sudo ./update.sh              # check once
sudo ./update.sh --install    # daily cron at 4 AM
sudo ./update.sh --uninstall  # remove cron
```

## Privacy & security

### What the server retains

| Data | Retained? | Notes |
|------|-----------|-------|
| Video URLs | No | Only in browser memory during extraction |
| Downloaded files | No | Securely overwritten and deleted after job completion |
| Download history | No | Job metadata cleared from memory when jobs finish |
| Darkreel delegation (refresh token + public key) | Encrypted at rest | AES-256-GCM with AAD, per-user master key. Passwords are never stored — see "Darkreel integration" below. |
| Usernames | Yes (plaintext) | Use non-identifying usernames |
| Passwords | Hashed (Argon2id) | Separate auth salt per user (t=3, m=64MB, p=4) |
| Master keys | Encrypted at rest | Encrypted with password-derived key + recovery code |
| Access logs | Optional | Caddy access logs can be disabled during setup |

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
                                  Decrypts: darkreel_delegations.encrypted_refresh_token
                                            (AES-256-GCM, AAD=userID)

Recovery Code ──> Decrypts: recovery_mk (AES-256-GCM, AAD=userID) ──> master_key
```

- Database stolen? The refresh token is useless without a live PPVDA user session (which holds the master key). Even if an attacker unwraps every stored refresh token, they get **upload-only** capability against each user's Darkreel library — they cannot read, list, or delete any existing media, because PPVDA holds only the user's Darkreel public key.
- Server compromised? Same upper bound as database theft — PPVDA never had decryption capability to begin with.
- Server restarted? All sessions cleared, users must re-login.
- Forgot password? Recovery code decrypts the master key, allowing a full password reset.

### Security measures

- **Argon2id password hashing** — Memory-hard hashing matching Darkreel (t=3, m=64MB, p=4, keyLen=32). Dual salts: separate auth salt for password hash and KDF salt for master key encryption
- **Authenticated encryption** — All encryption uses AES-256-GCM with AAD binding ciphertexts to their owner's user ID, preventing ciphertext substitution between users
- **Recovery codes** — 32-byte random codes generated on registration and rotated on every password change. Master key is independently encrypted with the recovery code
- **Timing-safe authentication** — Dummy Argon2id derivation performed for non-existent usernames, legacy scrypt users whose login fails, and duplicate-username registration attempts, preventing timing-based username enumeration across all entry points
- **Per-username rate limiting** — 10 login/recovery attempts per username per 15 minutes, defending against distributed brute-force even when per-IP limits are bypassed
- **Session isolation** — Sessions indexed by random session ID (not user ID), with session ID embedded in JWT. Password changes and recovery invalidate all existing sessions
- **SSRF protection** — Every outbound HTTP egress is forced through a validation choke-point so a hostname can't be resolved a second time after our check:
  - **Route-level validation** rejects obvious private/reserved addresses up front: RFC1918, loopback, link-local, cloud-metadata, IPv4-mapped IPv6, and obfuscated IPv4 encodings (decimal `http://2130706433/`, hex `http://0x7f.0.0.1/`, leading-zero octal `http://0177.0.0.1/`).
  - **Node direct downloads** resolve DNS once via `safeResolveHost`, then pin the resolved address into `http.get`/`https.get` via the `lookup` option. The HTTP client never does its own DNS lookup, so a rebinding server can't flip public → private between our validation and the actual connect. Redirects recurse through the same pinned flow so every hop is validated against the IP we just connected to. TLS hostname verification still uses the original URL hostname, so cert checks work correctly against the pinned IP.
  - **ffmpeg / ffprobe** egress goes through a loopback-only HTTP forward proxy started per invocation. Every `CONNECT` target (HTTPS) and every absolute-URI request (HTTP) is passed through `safeResolveHost` before the tunnel opens or the request is forwarded — so even segment URIs inside an HLS/DASH manifest, which ffmpeg fetches on its own and we can't pre-resolve, are validated. The proxy binds random loopback, refuses connections from anything but 127.0.0.1, and shuts down when ffmpeg exits.
  - **Chromium** extraction is defended at the browser layer via `--host-rules` mapping private CIDRs to `NOTFOUND` before any navigation attempt.
  - `file://` is removed from the ffmpeg/ffprobe protocol whitelist, so a user-influenced URL can't be turned into a local-file-read primitive.
  - Admin-facing errors from Darkreel's delegation-exchange endpoint have their upstream response body stripped before surfacing, so an admin intentionally targeting a private URL (same-LAN Darkreel) can't be turned into an SSRF response-body leak.
- **No shell injection** — All subprocesses (ffmpeg, ffprobe) spawned with argument arrays, never through a shell. No Darkreel password ever passes through a subprocess environment — the Darkreel client is in-process Node
- **Privilege-split Mullvad path** — When VPN is configured, `CAP_NET_ADMIN`-requiring operations (wg-quick, ip route, `/etc/resolv.conf`, `/etc/hosts`) are handled by a small Go helper (`wg-supervisor`) running as root. The Node process — and every subprocess it spawns including Chromium — runs as the unprivileged `ppvda` user and talks to the helper over a Unix socket (`SO_PEERCRED`-authenticated, peer uid must match `ppvda`). Recovers Chromium's user-namespace sandbox so a renderer RCE can't reach network config. See [Privilege split](#privilege-split) for the threat-model shift
- **Admin re-verification** — Admin status verified from the database on every privileged request. Revoking admin access takes effect immediately
- **Rate limiting** — 100 requests/min globally, 5/min on login/register/recover endpoints
- **Cookie security** — httpOnly, SameSite=strict, and Secure whenever the deployment URL (`PUBLIC_URL`) is HTTPS (falls back to `NODE_ENV === 'production'` for proxy-rewrite setups without `PUBLIC_URL`). No tokens in localStorage or query parameters
- **Minimal subprocess environment** — ffmpeg receives only PATH, HOME, and TMPDIR. Secrets like JWT_SECRET and MULLVAD_ACCOUNT are not leaked
- **Security headers** — CSP, HSTS, Permissions-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy on all responses
- **VPN bypass validation** — Hostnames and IPs in `VPN_BYPASS_HOSTS` validated before writing to system routes and `/etc/hosts`
- **No request logging** — URLs never appear in server logs. Rate limiting and session state are in-memory only and cleared on restart
- **Coarsened timestamps** — Database timestamps use year-week precision (`strftime('%Y-%W')`) matching Darkreel's approach. In-memory job timestamps rounded to the minute
- **Secure file deletion** — Downloaded media files overwritten with random data and fsynced before unlinking. **Caveat:** this is a defense-in-depth pass, not a forensic guarantee on modern filesystems — CoW (Btrfs/ZFS/APFS) and SSD wear-levelling mean the overwrite may not reach the original blocks. See [SECURITY.md](./SECURITY.md) for the recommended tmpfs-backed `TEMP_DIR` + full-disk-encryption posture
- **WAL hygiene** — SQLite WAL files checkpointed and truncated every 5 minutes and on shutdown; `PRAGMA secure_delete = ON` zeroes deleted row contents before the page is reused, so revoked Darkreel delegations and expired sessions don't linger in page slack
- **DNS privacy** — When Mullvad VPN is active, DNS queries route through the WireGuard tunnel
- **Memory security** — Master keys, derived keys, and passwords zeroed from memory immediately after use. Session cleanup runs every 60 seconds
- **Bootstrap credential cleanup** — Admin password stored in a separate bootstrap file during setup, shredded after the first health check. Never persists in `.env`. If the admin recovery code file (`admin-recovery-code.txt`) is not deleted manually after first run, the server logs a WARN on every startup reminding the operator to remove it
- **Encrypted database backups** — Daily backups encrypted with AES-256-CBC and a randomly generated key, 30-day retention
- **Protocol restriction** — ffmpeg and ffprobe inputs restricted to http/https protocols, blocking `file://`, `gopher://`, `concat:`, etc.
- **Legacy migration** — Users created with older scrypt/PBKDF2 auth are transparently upgraded to Argon2id + AAD on next login
- **SRI integrity** — Frontend JS and CSS loaded with subresource integrity hashes
- **JWT secret entropy** — `JWT_SECRET` is validated at startup for length AND Shannon entropy, so placeholder values like `"a" * 32` are rejected instead of silently enabling trivially-forgeable tokens
- **Per-session master-key binding** — Write paths that wrap data under the user's master key (Darkreel delegation connect) look up the key by the request's `sessionId`, not by user ID. Under multi-session churn, any-session lookup could wrap new data under an about-to-expire session's key, silently rendering it undecryptable after timeout

### VPN privacy

- Fresh WireGuard keys generated on every startup — no persistent cryptographic material on disk
- Device deregistered from Mullvad on clean shutdown
- Stale WireGuard tunnels from previous crashes cleaned up automatically on startup
- All extraction and download traffic routes through the tunnel, including DNS
- Darkreel uploads can bypass the VPN via `VPN_BYPASS_HOSTS` (direct connection for speed)
- Per-user VPN toggle permissions controlled by admin (in-memory, resets on restart for privacy)

### Password requirements

- 16-128 characters
- Must contain at least one letter, one number, and one symbol
- No whitespace allowed

## User management

### Admin bootstrap

On first startup, if the database is empty, PPVDA creates an admin user from `PPVDA_ADMIN_USERNAME` and `PPVDA_ADMIN_PASSWORD`. When using the setup script, the recovery code is displayed at the end and the password file is securely shredded. When running manually, the recovery code is written to `<DB_PATH_DIR>/admin-recovery-code.txt` (mode 0600) — read it, save it, then delete the file.

### Self-registration

Admins can enable self-registration from the **Admin** panel. When enabled, a **Register** tab appears on the login page. New users receive a recovery code on registration that must be saved immediately.

### Account recovery

If a user forgets their password, they can reset it using their recovery code via the **Forgot password?** link on the login page. Recovery codes are rotated on every password change and recovery — the old code is invalidated and a new one is displayed.

## Darkreel integration

PPVDA uploads to [Darkreel](https://github.com/baileywjohnson/darkreel) using the **delegation protocol** — PPVDA never holds your Darkreel password. Instead, each user connects their account once via a copy-paste authorization code; PPVDA stores a scoped refresh token and your public key, and uploads by sealing per-file AES keys directly to that public key.

**Blast-radius property:** a full compromise of PPVDA gives an attacker the ability to upload junk to your Darkreel library until you revoke. It does **not** give them read access to existing media, list access, delete capability, or any other account authority, because PPVDA holds only the public half of your X25519 keypair.

The upload pipeline: **download → encrypt (in-process, sealed-box to user's public key) → upload to Darkreel → secure delete local file**. No subprocess, no Darkreel password in environment variables, no `darkreel-cli` binary needed.

To set up:

1. Deploy a [Darkreel](https://github.com/baileywjohnson/darkreel) server (schema v2 required).
2. In Darkreel, go to **Settings → Authorize an App**, enter `PPVDA` as the client name and your PPVDA URL, then click **Generate Code**. The code expires in 2 minutes and can only be used once.
3. In PPVDA, go to **Settings → Darkreel Integration**, enter your Darkreel server URL and paste the code, then click **Connect**.

Revoke access anytime from Darkreel's **Settings → Connected Apps** (server-side) or PPVDA's **Settings → Darkreel Integration → Disconnect** (local only). A Darkreel-side revoke takes effect on PPVDA's next upload attempt (within 1 hour of access-token expiry).

Private/internal server URLs (`127.0.0.1`, `192.168.*`, `.internal` / `.local` hostnames, RFC1918 ranges) are allowed only for admin users, since they let PPVDA pivot its network position on the deployment host. Regular users must use a public URL or hostname.

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
| GET | `/settings/darkreel` | Check if Darkreel is connected; returns `{ configured, server_url, darkreel_user_id, connected_at }` |
| POST | `/settings/darkreel/connect` | Exchange a Darkreel authorization code for a refresh token and store it encrypted under the user's master key |
| DELETE | `/settings/darkreel` | Drop the local delegation row (server-side revocation is a separate click in Darkreel's Connected Apps UI) |

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
| GET | `/admin/vpn/permissions` | Get VPN permission state |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Feature flags and user context |
| GET | `/health` | Health check (no auth) |

## Configuration

All configuration is via environment variables (or `.env` file).

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_URL` | | External URL users hit (e.g., `https://ppvda.example.com`). When set, it's used as the explicit CORS allowed origin. When unset, CORS is disabled (secure default — browser same-origin policy blocks cross-origin Bearer-authenticated requests). |
| `DOWNLOAD_DIR` | `./downloads` | Temp directory (files auto-deleted after jobs) |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max parallel download/upload jobs |
| `MAX_CONCURRENT_EXTRACTIONS` | `3` | Max parallel Playwright browser extractions |
| `MAX_CONCURRENT_FFMPEG_ROUTES` | `MAX_CONCURRENT_DOWNLOADS` | Max parallel ffmpeg processes from `/stream-download` and `/thumbnail` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `PPVDA_ADMIN_USERNAME` | `admin` | Admin username (first-run only) |
| `PPVDA_ADMIN_PASSWORD` | **(required)** | Admin password (first-run only) |
| `JWT_SECRET` | **(required)** | JWT signing secret. Must be 32+ characters *and* pass a Shannon-entropy check — `"a" * 32` is rejected. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it stable across restarts or all existing sessions become invalid. |
| `DB_PATH` | `./data/ppvda.db` | SQLite database path |

### Darkreel uploads

| Variable | Default | Description |
|----------|---------|-------------|
| `DRK_UPLOAD_TIMEOUT_MS` | `600000` | Native upload timeout (10 min). No subprocess — uploads happen in-process via Node's Web Crypto. |

### Extraction and download

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_TIMEOUT_MS` | `30000` | Page load timeout |
| `NETWORK_IDLE_MS` | `2000` | Wait for network idle before finishing extraction |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Download timeout (5 min) |
| `MAX_DOWNLOAD_BYTES` | `10737418240` | Max bytes per direct/image download (10 GB). Prevents disk exhaustion from infinite or misconfigured upstream responses. Enforced via `Content-Length` check + streaming byte counter. |

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
| `ENABLE_THUMBNAILS` | `true` | Video thumbnail previews in extraction results |
| `MAX_JOB_HISTORY` | `100` | Completed jobs kept in memory |

## System requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 vCPU | 4+ vCPU |
| RAM | 2 GB | 4+ GB |
| Disk | 20 GB | 50+ GB |
| OS | Linux (amd64 or arm64) | Ubuntu 22.04+ / Debian 12+ |

PPVDA is heavier than Darkreel because it runs headless Chromium and ffmpeg. The 2 GB RAM minimum is driven by Chromium.

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
3. Credentials are encrypted and stored locally — PPVDA can't read them without your login session

### 4. Use it

1. Paste a video page URL and click **Extract**
2. Video cards appear progressively with type, quality, duration, and size tags
3. Click **Download** to save to your browser (streamed through ffmpeg, hash modified)
4. Click **Upload to Darkreel** to encrypt and store in your library
5. Stream your encrypted video from `https://media.example.com`

## Related

- [Darkreel](https://github.com/baileywjohnson/darkreel) — E2E encrypted media server
- [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli) — CLI upload tool for Darkreel

## License

MIT
