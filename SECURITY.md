# Security

## Threat model

PPVDA is a privacy-focused video extractor/downloader. It runs a headless Chromium against user-supplied URLs and optionally uploads results to a [Darkreel](https://github.com/baileywjohnson/darkreel) server for encrypted archival.

### In scope

- **SSRF defense**: user-supplied URLs cannot target RFC1918, loopback, link-local, cloud-metadata, or IPv6 private ranges. DNS rebinding is detected via double-resolution at the route level and blocked at the browser level via Chromium `--host-rules`.
- **Credential confidentiality**: users' Darkreel passwords are encrypted at rest with each user's master key (AES-256-GCM, AAD bound to user ID). They are never logged.
- **Authentication integrity**: Argon2id password hashing, timing-safe comparisons, dummy-hash-on-miss to prevent username enumeration, per-username rate limiting (10/15 min), `httpOnly` + `SameSite=strict` session cookies, JWT HS256 with a required `JWT_SECRET`.
- **Subprocess isolation**: `ffmpeg`, `darkreel-cli`, and WireGuard are spawned via argv arrays with explicit env — no shell, no inheritance of parent secrets beyond what each needs.
- **No persistent PII**: URLs are not logged, downloads are streamed to the client without intermediate storage, and no download history is retained.

### Out of scope

- **Browser-level zero-days in the bundled Chromium**. Playwright ships a pinned Chromium version; a zero-day against it is exploitable against any user-supplied page. See the `CVE tracking` section below for the live list. **PPVDA navigates arbitrary URLs, so this is a real and ongoing risk.**
- **Compromise of the VPN layer itself** (e.g., Mullvad egress bugs, WireGuard cryptographic failures). Application-level kill-switch (see below) guards against tunnel failure but not against a successfully established tunnel that is itself compromised.
- **Compromise of the Darkreel server**. PPVDA trusts the configured Darkreel server for upload confidentiality. End-to-end encryption is handled by `darkreel-cli`, so a compromised Darkreel server sees encrypted blobs only — but a hostile server can still DoS the CLI via crafted responses (bounded, see `darkreel-cli` SECURITY.md).
- **Local attackers with shell access to the PPVDA host**. SQLite is unencrypted at rest; user Argon2 hashes are on disk. Pair with LUKS / FileVault / SQLCipher if backup theft is in your threat model.
- **Same-UID attackers reading `/proc/<pid>/environ`** of the `darkreel-cli` subprocess during upload, which contains the user's decrypted Darkreel password.

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

## Reporting a vulnerability

Email **baileywjohnson@gmail.com** with details. Please do not open a public issue for unfixed vulnerabilities. Include version, reproduction steps, and threat-model assumptions.

## Supported versions

Only `main` is supported. The deploy workflow ships the latest commit to production on every push to `main`; older commits are unsupported.

## Dependency hygiene

`npm audit --omit=dev --audit-level=high` runs on every push, PR, and weekly in CI (see `.github/workflows/security.yml`). A failing audit job against unchanged code usually signals a newly disclosed CVE — upgrade promptly.

## Future work

- Short-lived scoped Darkreel upload tokens to replace the `DRK_PASS` subprocess-env flow.
- Optional SQLCipher for at-rest DB encryption.
