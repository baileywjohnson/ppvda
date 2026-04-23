# Security

## Threat model

PPVDA is a privacy-focused video extractor/downloader. It runs a headless Chromium against user-supplied URLs and optionally uploads results to a [Darkreel](https://github.com/baileywjohnson/darkreel) server for encrypted archival.

### In scope

- **SSRF defense**: user-supplied URLs cannot target RFC1918, loopback, link-local, cloud-metadata, or IPv6 private ranges, *including* obfuscated IPv4 encodings (decimal `http://2130706433/`, hex `http://0x7f.0.0.1/`, leading-zero octal). DNS rebinding is detected via double-resolution at the route level and blocked at the browser level via Chromium `--host-rules`.
- **Credential confidentiality**: PPVDA no longer holds any Darkreel password. Connect runs a delegation exchange (copy-paste authorization code) that returns a scoped refresh token + the user's Darkreel X25519 public key; PPVDA stores only those two, with the refresh token AES-256-GCM-encrypted at rest under the user's PPVDA master key (AAD = user ID). A full PPVDA compromise grants *upload-only* capability to each connected Darkreel account — not read, list, or delete.
- **Authentication integrity**: Argon2id password hashing, timing-safe comparisons, dummy-hash-on-miss to prevent username enumeration, per-username rate limiting (10/15 min), `httpOnly` + `SameSite=strict` + `Secure` session cookies (Secure is gated on `PUBLIC_URL` being HTTPS, falling back to `NODE_ENV === 'production'`), JWT HS256 with a required `JWT_SECRET` that's length-AND-entropy-checked at startup.
- **Subprocess isolation**: `ffmpeg`, `ffprobe`, and WireGuard are spawned via argv arrays with explicit env — no shell, no inheritance of parent secrets beyond what each needs. Darkreel uploads run in-process (sealed-box crypto via Node's Web Crypto); there is no subprocess to leak environment variables.
- **No persistent PII**: URLs are not logged, downloads are streamed to the client without intermediate storage, and no download history is retained.

### Out of scope

- **Browser-level zero-days in the bundled Chromium**. Playwright ships a pinned Chromium version; a zero-day against it is exploitable against any user-supplied page. See the `CVE tracking` section below for the live list. **PPVDA navigates arbitrary URLs, so this is a real and ongoing risk.**
- **Compromise of the VPN layer itself** (e.g., Mullvad egress bugs, WireGuard cryptographic failures). Application-level kill-switch (see below) guards against tunnel failure but not against a successfully established tunnel that is itself compromised.
- **Compromise of the Darkreel server**. PPVDA uploads go out sealed to the user's X25519 public key, so a compromised Darkreel server sees ciphertext and opaque sealed keys only. A hostile server could still refuse uploads, return tampered media to other browsers, or mint bogus pagination responses — PPVDA bounds response sizes to make the latter a bandwidth nuisance rather than memory exhaustion.
- **Local attackers with shell access to the PPVDA host**. SQLite is unencrypted at rest; user Argon2 hashes are on disk. Pair with LUKS / FileVault / SQLCipher if backup theft is in your threat model.

## Deployment requirements

### Required environment variables

- `JWT_SECRET` — 32+ character random string. Required in **every** environment (no dev fallback). Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `PPVDA_ADMIN_PASSWORD` — required on first launch only, for admin bootstrap. Must pass `isStrongPassword` (16+ chars, letter + digit + symbol, no spaces). The bootstrap writes a one-time recovery code to `<data-dir>/admin-recovery-code.txt` (chmod 0600). Read it, save it elsewhere, then delete the file. PPVDA warns on every subsequent startup while the file exists.

### Reverse proxy posture

Set `trustProxy` in Fastify **only** if PPVDA is deployed behind a trusted reverse proxy. Without a proxy, leaving it off is correct; with one, configure it to the proxy's CIDR so `X-Forwarded-For` is not spoofable by clients.

### VPN configuration

If `MULLVAD_ACCOUNT` is set, the Mullvad tunnel is brought up before the listener starts and route exceptions for API gateways are resolved before the tunnel. Two layers of defense follow:

1. **OS kill-switch** — routing is configured so non-bypass traffic can only exit via `wg0`. Configure `iptables` / `nftables` / `pf` on the host (Docker `NET_ADMIN` capability is granted in `docker-compose.yml`).
2. **Application kill-switch** — on startup, PPVDA runs initial interface + routing probes and refuses to serve traffic unless both pass. While running, it polls `/sys/class/net/wg0` every 5 s and curls `https://am.i.mullvad.net/connected` every 60 s; any persistent failure flips the in-process health flag, causing all `/extract*`, `/download*`, and `/stream-download*` routes (plus the background job pipeline) to return `503 VPN_KILL_SWITCH` until the tunnel recovers. See `src/mullvad/health.ts`.

The application kill-switch is a no-op when `MULLVAD_ACCOUNT` is unset (bare deploy): routes behave as plain authenticated endpoints.

### Playwright CVE tracking

Playwright ships a pinned Chromium. When a Chromium CVE affects navigation (particularly CVEs affecting renderer, CSS, or JS engines), PPVDA is affected until the Playwright team tags a release containing the Chromium roll. Dependabot (see `.github/dependabot.yml`) opens a PR for every Playwright release so Chromium security rolls land as their own reviewable change — upgrade these promptly. The current Chromium version can be checked in `package-lock.json`; compare against [chromereleases.googleblog.com](https://chromereleases.googleblog.com/).

### Database at rest

SQLite at `./data/ppvda.db` is unencrypted by default. It contains Argon2 hashes, encrypted Darkreel credentials (per-user-key, AES-256-GCM), and session metadata. If backup theft is part of your threat model, either:
- deploy on a LUKS / FileVault / encrypted-EBS host, or
- swap `better-sqlite3` for `better-sqlite3-multiple-ciphers` and configure a cipher key passed via a secret manager.

`secure_delete = ON` is enabled, so deleted rows (including revoked delegations and expired sessions) are zeroed before the page is reused — not just marked free in the btree.

### Temp-file plaintext at rest

Downloaded video files live briefly in `DOWNLOAD_DIR` (default `./downloads/`) as plaintext before being encrypted and shipped to Darkreel (or deleted if no delegation is configured). `secureUnlink` overwrites each file with random bytes and datasyncs before unlinking, but on modern filesystems this overwrite **does not reliably reach the original blocks**:

- **Copy-on-write filesystems** (Btrfs, ZFS, APFS, XFS reflinks): an overwrite allocates a new block; the original blocks keep the plaintext until the FS garbage-collects them.
- **SSDs / NVMe**: wear-levelling scatters writes across flash pages — the "same LBA" may map to completely different physical pages before vs after the overwrite. The plaintext page is still flagged as garbage in the FTL but not erased until the next TRIM + block erase.
- **Log-structured / journaling filesystems** retain historical page contents in the journal.

To actually get forensic resistance on the temp-file surface, you need **full-disk encryption plus an ephemeral tmpfs**:

1. Run the host/container on LUKS / FileVault / encrypted EBS (also covers the SQLite DB — see above).
2. Set `TEMP_DIR=/dev/shm/ppvda-tmp` (or a tmpfs bind-mount in the Docker compose), which backs the download directory with RAM. Files never touch disk at all; on reboot everything is gone regardless of the overwrite pass.

Without FDE, treat `secureUnlink` as a defence-in-depth speed bump against naïve disk recovery, not a forensic guarantee. The function is useful on ext4/xfs over a LUKS-encrypted rotational disk; on most other deployments its security contribution is marginal.

## Reporting a vulnerability

Email **baileywjohnson@gmail.com** with details. Please do not open a public issue for unfixed vulnerabilities. Include version, reproduction steps, and threat-model assumptions.

## Supported versions

Only `main` is supported. The deploy workflow ships the latest commit to production on every push to `main`; older commits are unsupported.

## Dependency hygiene

`npm audit --omit=dev --audit-level=high` runs on every push, PR, and weekly in CI (see `.github/workflows/security.yml`). A failing audit job against unchanged code usually signals a newly disclosed CVE — upgrade promptly.

## Future work

- Short-lived scoped Darkreel upload tokens to replace the `DRK_PASS` subprocess-env flow.
- Optional SQLCipher for at-rest DB encryption.
