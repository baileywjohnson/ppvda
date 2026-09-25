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
- **Browser download** — Videos are remuxed through ffmpeg and sent to your browser. The remuxed file is staged in a private per-request directory under `DOWNLOAD_DIR` only for the duration of the response, then securely overwritten and unlinked; the downloaded file has a different hash from the original
- **Ad filtering** — Built-in blocklist of ~28 ad-tech domains, plus size/duration filtering
- **Darkreel integration** — Background jobs: download, encrypt in-process (X25519 sealed-box to your Darkreel public key, Darkreel's padded chunk format 2), upload to your encrypted library, securely delete local file. PPVDA never holds your Darkreel password — connect once via a copy-paste authorization code and revoke anytime from Darkreel's Connected Apps panel
- **Mullvad VPN** — Built-in WireGuard tunnel with a network-level kill switch. All extraction and download traffic routes through Mullvad with country switching from the admin panel
- **Proxy support** — Route traffic through SOCKS4/5 or HTTP/HTTPS proxies as an alternative to Mullvad
- **Multi-user** — Self-registration (admin-toggleable) or admin-managed user creation. Each user gets an independent master key and connects their own Darkreel account
- **Account recovery** — Recovery codes generated on registration and password change. The only way to recover an account if the password is forgotten
- **Delegation-based Darkreel credentials** — PPVDA stores an upload-scoped refresh token (AES-256-GCM encrypted at rest under each user's master key) + your Darkreel X25519 public key. No Darkreel password is ever held — a full PPVDA compromise grants upload-only capability, not read/list/delete on existing media
- **Host filtering** — Allow, block, or prioritize videos from specific domains
- **Concurrency control** — Configurable limits on parallel downloads and extractions, plus fixed per-user caps and bounded queues
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

Browser downloads (`/stream-download`) of videos remux to fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`, fragments cut at least every second), which changes the file hash relative to the original; images are passed through unchanged. The remuxed output is written to a private (0700) per-request directory under `DOWNLOAD_DIR` for the duration of the response, streamed to the client, then overwritten with random bytes and unlinked — it is not retained after the request. Job-pipeline HLS/DASH downloads are produced the same way, then encrypted and uploaded before the local copy is securely deleted.

### Job pipeline

```
submit → extract (optional) → download → remux to fMP4 (videos) → seal + encrypt + upload → secure delete
```

For direct video downloads (plain file URLs, not HLS/DASH), PPVDA remuxes to fragmented MP4 before upload (same flags, 1-second fragments) so Darkreel's MSE player can stream them; if that fails the file is uploaded unfragmented and Darkreel plays it after a full download. Pre-fragmented output from the HLS/DASH path skips the extra remux. Fragments are packed into chunks that fill 1 MiB ciphertext buckets.

Every job works in its own private (0700) directory under `DOWNLOAD_DIR`, removed with secure overwrite when the job ends, whether it succeeded or failed; directories left by a crash are purged at startup. Without a connected Darkreel account a job downloads and then deletes the file.

Jobs run with a configurable concurrency semaphore; each user can have at most 10 queued or running jobs (`429` beyond that). Each stage updates the job store, which emits events to connected clients. Terminal jobs have sensitive metadata (file path, size, format) cleared from memory.

## Deploy

### Setup script on a fresh VPS

The script runs as root, so check what you're running first: clone, verify the newest release tag against the maintainer's SSH release key (obtained through a channel you trust — not from this repository), check it out, read the script, then run it. Don't pipe it from the network into a shell (its prompts need a terminal anyway).

```bash
git clone https://github.com/baileywjohnson/ppvda.git && cd ppvda
git tag -l 'v*' --sort=-v:refname | head -1        # newest release, e.g. v1.2.3
echo "release-signer ssh-ed25519 AAAA..." > /tmp/ppvda_signers
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=/tmp/ppvda_signers verify-tag v1.2.3 \
  && git checkout v1.2.3
less setup.sh
sudo ./setup.sh
```

Setup uses the checkout it is run from and records its location for the CI deploy hook; `update.sh` updates the checkout it lives in.

The script prompts for:

- **Domain name** (optional, for automatic HTTPS via Caddy)
- **Admin username and password** (16+ chars with letter, number, symbol)
- **Mullvad account and location** (optional, for WireGuard VPN)
- **Darkreel server URL** (optional; with Mullvad, its host is written to `VPN_BYPASS_HOSTS` so uploads go direct)
- **SSH user** (optional, for secure remote access)
- **Access log privacy** (optional, disables Caddy request logs)
- **Release signer SSH key** (optional, unless already pinned in `/etc/ppvda/allowed_signers`) — pinned there and used both to pick the code to build and by the auto-updater
- **Auto-updates** (optional, daily `update.sh` run)

Setup builds the newest `vX.Y.Z` tag whose signature verifies against the pinned key. With no key pinned, or no signed release yet, it builds the current checkout and says loudly that it is unverified.

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
| **Docker** | Docker + Compose installed from Docker's apt repository (signing key checked against its published fingerprint) |
| **Application** | PPVDA container with Chromium, ffmpeg, WireGuard |
| **Reverse proxy** | Caddy, always installed. With a domain: automatic Let's Encrypt TLS. Without one: plain HTTP on :80. The container publishes port 3000 on host loopback only, so Caddy is the sole ingress and UFW actually governs the exposed port. |
| **Access log privacy** | Optional: Caddy access logs discarded (no IP/URL logging) |
| **VPN** | Mullvad WireGuard tunnel (if account provided) |
| **Database backups** | Daily encrypted backup at 3 AM (AES-256-CBC, 30-day retention) |
| **Credential security** | Admin password kept out of `.env` (in a mode-600 `bootstrap.env`); once the admin account exists it is shredded and the container recreated without it (so it's gone from `docker inspect`). If PPVDA isn't up by the end of setup, a background job does this as soon as it is. `.env` is mode 600 |
| **CI deploy hook** | A `deploy` user that may only `sudo ppvda-deploy <commit>`, which checks out the commit only if it has an Ed25519 signature from `/etc/ppvda/signing.pub` and descends from what is running. Fails closed without the key |

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

# Optional: Mullvad VPN (MULLVAD_LOCATION is required with it)
MULLVAD_ACCOUNT=your-account-number
MULLVAD_LOCATION=se
```

```bash
docker compose up --build -d
```

Open `http://localhost:3000` and log in. The container includes ffmpeg, Chromium, and WireGuard tools.

> The container publishes port 3000 on **loopback only**. That is deliberate: Docker's published ports are handled by its own iptables chain, which is evaluated before UFW's rules, so a `0.0.0.0` bind would be reachable from the internet even with `ufw deny 3000`. To reach PPVDA from another machine, put a reverse proxy in front of it (`./setup.sh` installs and configures Caddy for you) rather than changing this binding.

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

1. Removes any Mullvad device a previous run of this instance registered but never deregistered (crash, failed start)
2. Picks a relay for `MULLVAD_LOCATION` and routes the bypass hosts — before registering anything, so a bad location doesn't cost a device
3. Generates fresh WireGuard keys and registers a device with the Mullvad API
4. Brings up a WireGuard tunnel routing all traffic through the selected country — `wg-supervisor` first checks the relay against Mullvad's relay list and installs the kill switch; if the bring-up fails, the device is deregistered again
5. On shutdown, deregisters the device from Mullvad

PPVDA only ever removes devices it registered itself, recognised by id and public key (kept in `mullvad-devices.json` next to the database). If the account is at Mullvad's device limit, startup fails with a message instead of evicting a device — which might be your phone.

If your Darkreel server is on a different host, add it to `VPN_BYPASS_HOSTS` so uploads go direct:

```bash
VPN_BYPASS_HOSTS=media.example.com
```

The bypass list is fixed when the container starts: the entrypoint hands it (plus `api.mullvad.net`) to `wg-supervisor`, which resolves each name itself — IPv4 only, and every address must be public unicast (a same-host Darkreel should be listed by its public name, not reached via `host.docker.internal`). The addresses are pinned (and written to `/etc/hosts`) for the life of the container, so changing the list, or picking up a DNS change, takes a restart. At most 16 entries including `api.mullvad.net`; more stops the supervisor from starting.

Admins can switch VPN countries from the admin panel without restarting the container. The admin panel's VPN default and per-user VPN toggle only decide whether requests use `PROXY_URL`; with Mullvad configured, all container traffic goes through the tunnel regardless.

### Privilege split

The Node process (and everything it spawns — Playwright, Chromium, ffmpeg, ffprobe) always runs as the unprivileged `ppvda` user, in both the bare and the Mullvad deployments. This lets Chromium's user-namespace sandbox work, so a renderer bug lands in a confined process instead of container root.

In the Mullvad deployment, the operations that genuinely require `CAP_NET_ADMIN` — `wg-quick up`/`down`, `ip route add`, writing `/etc/resolv.conf` and `/etc/hosts` — are handled by a small privileged helper called **`wg-supervisor`**, written in Go (see [`wg-supervisor/`](wg-supervisor/)). The supervisor runs as root and listens on a Unix socket at `/run/ppvda/wg.sock`; the Node process sends length-prefixed JSON RPCs for four fixed operations (`BRINGUP`, `TEARDOWN`, `ADD_ROUTES`, `GATEWAY`). The supervisor authenticates every incoming connection via `SO_PEERCRED` and only accepts peers with the `ppvda` uid. No network listeners, no user input beyond the RPC payload. `ADD_ROUTES` takes hostnames only, and only those on the bypass list pinned at container start; the supervisor resolves them itself. `BRINGUP` is only accepted for a relay that Mullvad's relay list names as an active WireGuard relay (same public key, IPv4 and an advertised port); the supervisor fetches that list itself over HTTPS from `api.mullvad.net`, via the pinned bypass addresses, and refuses the bring-up if it can't.

What this changes for the threat model: a Chromium renderer RCE (V8 bug, image codec bug, etc. — Chromium gets a couple of these a year) used to land in a root process with `NET_ADMIN` and could defeat the VPN kill-switch, edit `/etc/hosts`, or modify the routing table. Now it lands in Chromium's sandboxed renderer; escaping that yields code running as the unprivileged `ppvda` user, which can read what the app can read but not touch network configuration. Code that does run as the `ppvda` uid (a full sandbox escape, or an ffmpeg bug) can reach the supervisor, but can't route an address of its choice around the tunnel or lift the kill switch; it can tear the tunnel down (denial of service only — the kill switch stays) or bring it up against a different *Mullvad* relay, but not against an endpoint of its own, which would reveal the server's real IP to that endpoint. See [SECURITY.md](SECURITY.md).

The bare deployment (no `MULLVAD_ACCOUNT`) doesn't start the supervisor and skips the socket entirely — Node just runs directly as `ppvda` since no privileged ops are needed.

### Backups

The setup script configures daily encrypted database backups:

- **Schedule:** 3 AM daily via cron
- **Encryption:** AES-256-CBC with a randomly generated key
- **Retention:** 30 days (older backups auto-deleted)
- **Key location:** `<repo>/backup.key` — back this up separately. It sits on the same host as the backups, so the encryption protects copies taken off the host, not against someone with access to it

To restore:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in backups/ppvda-20260412.db.enc \
  -out ppvda-restored.db \
  -pass file:backup.key
```

### Upgrading

```bash
cd /path/to/your/ppvda/checkout
git fetch --tags
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=/etc/ppvda/allowed_signers verify-tag vX.Y.Z \
  && git checkout vX.Y.Z
docker compose up --build -d
```

Or use the auto-updater. It takes the newest `vX.Y.Z` tag and deploys it only if its SSH signature verifies against `/etc/ppvda/allowed_signers` and it is a fast-forward of what's running — it never deploys an unsigned commit or rolls back, and without a pinned signer it refuses to run. It runs as root and rebuilds the container, so an unverified update would be root on the host.

```bash
# one-time: pin the release signer's SSH public key
echo "release-signer ssh-ed25519 AAAA..." | sudo tee /etc/ppvda/allowed_signers

sudo ./update.sh              # check once
sudo ./update.sh --install    # daily cron at 4 AM
sudo ./update.sh --uninstall  # remove cron
```

Releases are signed tags: `git config gpg.format ssh && git config user.signingkey ~/.ssh/id_ed25519.pub`, then `git tag -s v1.2.3 -m v1.2.3 && git push origin v1.2.3`.

## Privacy & security

### What the server retains

| Data | Retained? | Notes |
|------|-----------|-------|
| Video URLs | No | Only in browser memory during extraction |
| Downloaded files | No | Securely overwritten and deleted after job completion. No endpoint leaves media on disk past the request that created it. |
| Download history | No | Job metadata cleared from memory when jobs finish |
| Darkreel delegation (refresh token + public key) | Encrypted at rest | Refresh token AES-256-GCM with AAD under the per-user master key; the public key and server URL are stored as is. Passwords are never stored — see "Darkreel integration" below. |
| Mullvad devices | Yes (`mullvad-devices.json`) | Id and public key of devices this instance registered, so leftovers from a crash can be removed. No private keys |
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
- Server compromised while running? The attacker sees what PPVDA handles: passwords at login, the master keys of logged-in users, submitted URLs, and every file it downloads, in plaintext, before encryption. Against Darkreel it is still upload-only — PPVDA never had the keys to read, list or delete what is already in your library.
- Server restarted? All sessions cleared, users must re-login.
- Forgot password? Recovery code decrypts the master key, allowing a full password reset.

### Security measures

- **Argon2id password hashing** — Memory-hard hashing matching Darkreel (t=3, m=64MB, p=4, keyLen=32). Dual salts: separate auth salt for password hash and KDF salt for master key encryption
- **Authenticated encryption** — All encryption uses AES-256-GCM with AAD binding ciphertexts to their owner's user ID, preventing ciphertext substitution between users
- **Recovery codes** — 32-byte random codes generated on registration and rotated on every password change. Master key is independently encrypted with the recovery code
- **Timing-safe authentication** — Dummy Argon2id derivation performed for non-existent usernames, legacy scrypt users whose login fails, and duplicate-username registration attempts; recovery for an unknown username opens a dummy blob, costing the same as a wrong code. Prevents timing-based username enumeration across all entry points
- **Per-username rate limiting** — 10 *failed* attempts per username per 15 minutes, counted separately for login and recovery (successes never count, and hammering one can't lock the other). Keys are hashed usernames; usernames and passwords have length caps. Defends against distributed brute-force even when per-IP limits are bypassed
- **Session isolation** — Sessions indexed by random session ID (not user ID), with session ID embedded in JWT. Password changes and recovery invalidate all existing sessions
- **SSRF protection** — Every outbound HTTP egress is forced through a validation choke-point so a hostname can't be resolved a second time after our check:
  - **Route-level validation** rejects obvious private/reserved addresses up front: RFC1918, loopback, link-local, cloud-metadata, IPv4-mapped IPv6, and obfuscated IPv4 encodings (decimal `http://2130706433/`, hex `http://0x7f.0.0.1/`, leading-zero octal `http://0177.0.0.1/`).
  - **Node direct downloads** resolve DNS once via `safeResolveHost`, then pin the resolved address into `http.get`/`https.get` via the `lookup` option. The HTTP client never does its own DNS lookup, so a rebinding server can't flip public → private between our validation and the actual connect. Redirects recurse through the same pinned flow so every hop is validated against the IP we just connected to. TLS hostname verification still uses the original URL hostname, so cert checks work correctly against the pinned IP.
  - **ffmpeg / ffprobe** egress goes through a loopback-only HTTP forward proxy started per invocation. Every `CONNECT` target (HTTPS) and every absolute-URI request (HTTP) is passed through `safeResolveHost` before the tunnel opens or the request is forwarded — so even segment URIs inside an HLS/DASH manifest, which ffmpeg fetches on its own and we can't pre-resolve, are validated. `safeResolveHost` checks every address a name resolves to against all reserved IPv4/IPv6 ranges (including NAT64, 6to4 and Teredo, which embed IPv4). The proxy listens on a random `127.0.0.1` port and shuts down when ffmpeg exits.
  - **Chromium** is launched with that same SSRF proxy as its proxy server, so every navigation, subresource, redirect and fetch/XHR/WebSocket from page JS is resolved and validated there (loopback included — it is not bypassed). `--host-rules` mapping private CIDRs to `NOTFOUND` remains as defense in depth. WebRTC is restricted to proxied connections (`disable_non_proxied_udp`) and QUIC is off, so a page can't learn the server's IP over STUN.
  - **With `PROXY_URL`** the SSRF proxy chains to your proxy instead of connecting directly: targets are checked by their literal host (private names, IP literals, obfuscated encodings) and names are resolved by your proxy, never by this host's resolver. SOCKS URLs use remote resolution (`socks5h`/`socks4a`) for Node downloads as well. If your proxy runs on the same host, it can reach that host's loopback services by name — prefer a remote proxy.
  - IPs routed around the VPN (`VPN_BYPASS_HOSTS`, the Mullvad API) are refused as extraction targets, so a URL whose host shares an IP with them (e.g. a CDN edge) can't be fetched outside the tunnel.
  - **Chromium sandbox** is on (`CHROMIUM_SANDBOX=false` disables it; not recommended). In Docker it needs the seccomp profile in `chromium-seccomp.json`, which `docker-compose.yml` applies.
  - `file://` is removed from the ffmpeg/ffprobe protocol whitelist, so a user-influenced URL can't be turned into a local-file-read primitive.
  - Admin-facing errors from Darkreel's delegation-exchange endpoint have their upstream response body stripped before surfacing, so an admin intentionally targeting a private URL (same-LAN Darkreel) can't be turned into an SSRF response-body leak.
- **No shell injection** — All subprocesses (ffmpeg, ffprobe) spawned with argument arrays, never through a shell. No Darkreel password ever passes through a subprocess environment — the Darkreel client is in-process Node
- **Privilege-split Mullvad path** — When VPN is configured, `CAP_NET_ADMIN`-requiring operations (wg-quick, ip route, `/etc/resolv.conf`, `/etc/hosts`) are handled by a small Go helper (`wg-supervisor`) running as root. The Node process — and every subprocess it spawns including Chromium — runs as the unprivileged `ppvda` user and talks to the helper over a Unix socket (`SO_PEERCRED`-authenticated, peer uid must match `ppvda`). Recovers Chromium's user-namespace sandbox so a renderer RCE can't reach network config. See [Privilege split](#privilege-split) for the threat-model shift
- **Admin re-verification** — The admin flag is read from the database on every authenticated request, never from the JWT. Revoking admin access takes effect immediately
- **Rate limiting** — 100 requests/min per IP globally, 5/min on login/register/recover, 10/min on `/extract`, `/extract/stream`, `/jobs` and `/stream-download`
- **Per-user limits** — at most 10 active jobs, 2 browser downloads, 8 thumbnails, 3 `/extract` and 3 `/extract/stream` requests per user; shared queues are bounded (32) and answer `503` when full, and work is cancelled when the client disconnects
- **Cookie security** — httpOnly, SameSite=strict, and Secure whenever the deployment URL (`PUBLIC_URL`) is HTTPS (falls back to `NODE_ENV === 'production'` for proxy-rewrite setups without `PUBLIC_URL`). No tokens in localStorage or query parameters
- **Minimal subprocess environment** — ffmpeg/ffprobe receive only PATH, HOME, TMPDIR and the SSRF-proxy variables; Chromium only PATH, HOME, TMPDIR and locale/font variables. Secrets like JWT_SECRET and MULLVAD_ACCOUNT are not leaked
- **Security headers** — CSP, HSTS, Permissions-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy on app responses. Download and thumbnail responses carry upstream bytes, so they get `nosniff` and a `default-src 'none'; sandbox` CSP instead, and `/thumbnail` only labels allowed raster image types as images
- **VPN bypass pinning** — The hosts in `VPN_BYPASS_HOSTS` (plus the Mullvad API) are fixed when the container starts and resolved by the privileged supervisor itself; only public IPv4 addresses are routed, and nothing running as the app user can add others
- **No request logging** — URLs never appear in server logs; failures are logged as error codes, not messages (which could carry hostnames), and the Mullvad connectivity probe's reply, which names the server's IP when it isn't tunneled, is never logged. Rate limiting and session state are in-memory only and cleared on restart
- **Coarsened timestamps** — Database timestamps use year-week precision (`strftime('%Y-%W')`) matching Darkreel's approach. In-memory job timestamps rounded to the minute
- **Secure file deletion** — Downloaded media files overwritten with random data and fsynced before unlinking. **Caveat:** this is a defense-in-depth pass, not a forensic guarantee on modern filesystems — CoW (Btrfs/ZFS/APFS) and SSD wear-levelling mean the overwrite may not reach the original blocks. See [SECURITY.md](./SECURITY.md) for the recommended tmpfs-backed `DOWNLOAD_DIR` + full-disk-encryption posture
- **WAL hygiene** — SQLite WAL files checkpointed and truncated every 5 minutes and on shutdown; `PRAGMA secure_delete = ON` zeroes deleted row contents before the page is reused, so disconnected Darkreel delegations and deleted users don't linger in page slack. The pre-delegation `darkreel_creds` table (encrypted Darkreel passwords) is deleted and the database vacuumed on first start
- **DNS privacy** — When Mullvad VPN is active, DNS queries route through the WireGuard tunnel
- **Memory security** — Master keys, derived keys, and passwords zeroed from memory immediately after use. Session cleanup runs every 60 seconds
- **Bootstrap credential cleanup** — Admin password stored in a separate bootstrap file during setup, shredded once the admin account exists, and the container recreated without it. Never persists in `.env`. If the admin recovery code file (`admin-recovery-code.txt`) is not deleted after first run, the server logs a WARN on every startup reminding the operator to remove it
- **Protocol restriction** — ffmpeg and ffprobe inputs restricted to http/https protocols, blocking `file://`, `gopher://`, `concat:`, etc. Downloaded files are re-read (remux, thumbnail, probe) with `-protocol_whitelist file` and a demuxer forced from the file's magic bytes (mp4/mov, mkv/webm, avi, flv, asf, mpeg-ts, jpeg/png/gif/webp/bmp); anything else — including playlists or concat scripts saved under a video name — is never handed to ffmpeg
- **Legacy migration** — Users created with older scrypt/PBKDF2 auth are transparently upgraded to Argon2id + AAD on next login
- **SRI integrity** — Frontend JS and CSS loaded with subresource integrity hashes
- **JWT secret entropy** — `JWT_SECRET` is validated at startup for length AND Shannon entropy, so placeholder values like `"a" * 32` are rejected instead of silently enabling trivially-forgeable tokens
- **Per-session master-key binding** — Write paths that wrap data under the user's master key (Darkreel delegation connect) look up the key by the request's `sessionId`, not by user ID. Under multi-session churn, any-session lookup could wrap new data under an about-to-expire session's key, silently rendering it undecryptable after timeout

### VPN privacy

- Fresh WireGuard keys generated on every startup. The private key only exists in the supervisor's root-only `/run/wg-supervisor/wg0.conf` while the tunnel is up and is overwritten on teardown
- Device deregistered from Mullvad on clean shutdown; one left behind by a crash is removed on the next start
- Stale WireGuard tunnels from previous crashes cleaned up automatically on startup
- All extraction and download traffic routes through the tunnel, including DNS; the kill switch blocks everything else, also while the tunnel is down or being switched
- Darkreel uploads can bypass the VPN via `VPN_BYPASS_HOSTS` (direct connection for speed)
- VPN default and per-user VPN toggle permissions controlled by admin (in-memory, resets on restart for privacy); they apply to `PROXY_URL`, not to the Mullvad tunnel

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

**Blast-radius property:** a full compromise of PPVDA gives an attacker the ability to upload junk to your Darkreel library until you revoke. It does **not** give them read access to existing media, list access, delete capability, or any other account authority, because PPVDA holds only the public half of your X25519 keypair. It does see everything PPVDA itself downloads, in plaintext, while it is compromised.

PPVDA can't compute Darkreel's owner tag (that takes your master key), so its uploads carry an **APP** badge in Darkreel's gallery, marking them as added by a connected app rather than by you. Renaming or moving an item in Darkreel re-tags it as yours.

The upload pipeline: **download → encrypt (in-process, sealed-box to user's public key, chunk format 2) → upload to Darkreel → secure delete local file**. No subprocess, no Darkreel password in environment variables, no `darkreel-cli` binary needed. The upload is streamed, so only one chunk is in memory at a time. A job needs its owner's PPVDA session (the refresh token is encrypted under their master key): logging out mid-job fails the upload.

To set up:

1. Deploy a [Darkreel](https://github.com/baileywjohnson/darkreel) server (schema v2) whose web client reads chunk format 2 — older ones can't play PPVDA's uploads.
2. In Darkreel, go to **Settings → Authorize an App**, enter `PPVDA` as the client name and your PPVDA URL, then click **Generate Code**. The code expires in 2 minutes and can only be used once.
3. In PPVDA, go to **Settings → Darkreel Integration**, enter your Darkreel server URL and paste the code, then click **Connect**.

Revoke access anytime from Darkreel's **Settings → Connected Apps** (server-side) or PPVDA's **Settings → Darkreel Integration → Disconnect** (local only). A Darkreel-side revoke takes effect immediately — PPVDA's next token refresh or upload is refused. PPVDA only accepts an upload-scoped delegation; anything broader is refused at connect time.

The server URL must be a bare origin (`https://darkreel.example.com` — no path, query or credentials) and must use `https://`. Private/internal server URLs (`127.0.0.1`, `192.168.*`, `.internal` / `.local` hostnames, RFC1918 ranges) and plain `http://` are allowed only for admin users, since they let PPVDA pivot its network position on the deployment host and expose the key exchange in transit. The URL is re-validated, resolved once and DNS-pinned on every exchange, refresh and upload, and the policy follows the user's *current* admin status.

After connecting, Settings shows the SHA-256 fingerprint of the public key PPVDA seals your uploads to. Compare it with the upload-key fingerprint Darkreel shows under Settings → Connected Apps (same SHA-256, same grouping); a mismatch means the key was swapped in transit — disconnect and revoke. Darkreel expires a connection after 60 days unused and a year after authorization; jobs then fail with a "revoked or expired — reconnect" message and you connect again with a new code. Responses from the Darkreel server are capped at 64 KB and shape-checked, and redirects are not followed.

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
| POST | `/stream-download` | Remux a video through ffmpeg (or pass an image through) and send it to the browser |
| GET | `/thumbnail` | Thumbnail for an extracted video or image (only when `ENABLE_THUMBNAILS` is on) |

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Submit download + Darkreel upload job (`429` with 10 already active) |
| GET | `/jobs` | List your jobs |
| GET | `/jobs/:id` | Get job status |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/darkreel` | Check if Darkreel is connected; returns `{ configured, server_url, darkreel_user_id, public_key_fingerprint, connected_at }` |
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
| POST | `/admin/vpn/switch` | Switch VPN country or city |
| PUT | `/admin/vpn/default` | Set server-wide VPN (`PROXY_URL`) default |
| PUT | `/admin/vpn/user-toggle` | Grant/revoke user VPN (`PROXY_URL`) toggle |
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
| `HOST` | `0.0.0.0` | Bind address (inside the container; `docker-compose.yml` publishes it on host loopback only) |
| `PUBLIC_URL` | | External URL users hit (e.g., `https://ppvda.example.com`). When set, it's used as the explicit CORS allowed origin. When unset, CORS is disabled (secure default — browser same-origin policy blocks cross-origin Bearer-authenticated requests). |
| `DOWNLOAD_DIR` | `./downloads` | Where per-job and per-request working directories are created (auto-deleted). See SECURITY.md for putting it on tmpfs |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max parallel download/upload jobs |
| `MAX_CONCURRENT_EXTRACTIONS` | `3` | Max parallel Playwright browser extractions |
| `MAX_CONCURRENT_FFMPEG_ROUTES` | `MAX_CONCURRENT_DOWNLOADS` | Max parallel ffmpeg processes from `/stream-download` and `/thumbnail` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | `production` in the Docker image | Without an `https://` `PUBLIC_URL`, `production` is what turns on `Secure` cookies |

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
| `DRK_UPLOAD_TIMEOUT_MS` | `600000` | Upload timeout per file (10 min). No subprocess — uploads happen in-process via Node's `crypto` module. |

### Extraction and download

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_TIMEOUT_MS` | `30000` | Page load timeout |
| `NETWORK_IDLE_MS` | `2000` | Wait for network idle before finishing extraction |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Download timeout (5 min) |
| `MAX_DOWNLOAD_BYTES` | `10737418240` | Max bytes per download (10 GB). Prevents disk exhaustion from infinite or misconfigured upstream responses. Direct/image downloads: `Content-Length` check + streaming byte counter. HLS/DASH and `/stream-download`: ffmpeg `-fs`; hitting the cap fails the download rather than keeping a truncated file. |
| `MAX_DOWNLOAD_DURATION_SEC` | `21600` | Longest HLS/DASH/stream download accepted (6 h). Live streams (no total duration) are always refused. |

### Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | | Proxy URL (`socks5://`, `socks4://`, `http://` or `https://`, e.g. `socks5://user:pass@host:port`). Extraction and download egress — Chromium, ffmpeg, Node downloads — goes through it, and DNS is resolved by the proxy. Whether a request uses it follows the admin's VPN default and per-user toggle |
| `CHROMIUM_SANDBOX` | `true` | Chromium's renderer sandbox. Needs the `chromium-seccomp.json` profile in Docker. Set `false` only if your host can't run it |

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
| `MULLVAD_ACCOUNT` | Mullvad account number. Setting it enables the tunnel, `wg-supervisor` and the kill switches; the container needs `NET_ADMIN` and `/dev/net/tun` (as in `docker-compose.yml`) |
| `MULLVAD_LOCATION` | Required with `MULLVAD_ACCOUNT`. Country code (`se`) or country-city (`se-mma`, `us-nyc`) |
| `MULLVAD_CONFIG_DIR` | Ignored. The WireGuard config (private key) is kept by `wg-supervisor` in its root-only `/run/wg-supervisor` |
| `VPN_BYPASS_HOSTS` | Comma-separated hostnames (or public IPv4 addresses) to route outside the VPN. Fixed at container start; must resolve to public IPv4 addresses; at most 15 besides `api.mullvad.net` |
| `WG_SUPERVISOR_SOCKET` | Socket Node uses to reach `wg-supervisor` (default `/run/ppvda/wg.sock`, where the entrypoint starts it). Leave unset |

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
# verify and check out the newest signed release first — see "Deploy" above
sudo ./setup.sh
# Follow prompts — enter your Mullvad account and Darkreel URL
```

### 3. Connect them

1. Log in to PPVDA at `https://download.example.com` and open **Settings → Darkreel Integration**
2. In Darkreel, go to **Settings → Authorize an App**, generate a code for `PPVDA`, and paste it into PPVDA with your Darkreel URL
3. Check that the key fingerprint PPVDA shows matches the one under Darkreel's **Connected Apps**. PPVDA stores only an upload-scoped refresh token (encrypted under your master key) and your public key — see [Darkreel integration](#darkreel-integration)

### 4. Use it

1. Paste a video page URL and click **Extract**
2. Video cards appear progressively with type, quality, duration, and size tags
3. Click **Download** to save to your browser (videos are remuxed through ffmpeg, so the hash differs from the original)
4. Click **Upload to Darkreel** to encrypt and store in your library
5. Stream your encrypted video from `https://media.example.com` (PPVDA uploads carry the APP badge)

## Related

- [Darkreel](https://github.com/baileywjohnson/darkreel) — E2E encrypted media server
- [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli) — CLI upload tool for Darkreel

## License

MIT
