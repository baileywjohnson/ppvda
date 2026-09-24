# Security

## Threat model

PPVDA is a privacy-focused video extractor/downloader. It runs a headless Chromium against user-supplied URLs and optionally uploads results to a [Darkreel](https://github.com/baileywjohnson/darkreel) server for encrypted archival.

### In scope

- **SSRF defense**: user-supplied URLs cannot target RFC1918, loopback, link-local, cloud-metadata, or IPv6 private ranges, *including* obfuscated IPv4 encodings. Defense is layered so every outbound egress hits a validator the HTTP client cannot bypass:
  - **Route-level checks** reject private / obfuscated addresses up front.
  - **Node download paths** (direct downloads, image proxy) use DNS pinning — one `safeResolveHost` call resolves + validates, the address is pinned into `http.get`'s `lookup` option, the client never re-resolves. Closes the DNS-rebinding window between check and connect. Redirect hops recurse through the same pinned flow.
  - **ffmpeg / ffprobe** go through a loopback-only forward proxy (per-invocation, random port, closed on exit). Every `CONNECT` and absolute-URI request is validated via `safeResolveHost` before the tunnel opens — so HLS/DASH segment URIs ffmpeg fetches autonomously can't reach private IPs either.
  - **Chromium** uses the same SSRF proxy for all of its traffic (Playwright forces loopback through it too), so DNS names that resolve to private addresses, redirects, subresources and requests from page JS are all validated. `--host-rules` stays as defense in depth. WebRTC is limited to proxied connections and QUIC is disabled.
  - `file://` is removed from the ffmpeg/ffprobe `-protocol_whitelist` so a user-influenced URL can't be redirected into local-file-read.
  - With `PROXY_URL`, the SSRF proxy chains to the operator's proxy: literal-host checks apply locally and names are resolved by the upstream proxy (never by this host's resolver). ffmpeg only understands `http://` proxies, so handing it the upstream URL directly — as earlier versions did — made it ignore a SOCKS/https proxy and connect from the real IP.
- **Credential confidentiality**: PPVDA no longer holds any Darkreel password. Connect runs a delegation exchange (copy-paste authorization code) that returns a scoped refresh token + the user's Darkreel X25519 public key; PPVDA stores only those two, with the refresh token AES-256-GCM-encrypted at rest under the user's PPVDA master key (AAD = user ID). A full PPVDA compromise grants *upload-only* capability to each connected Darkreel account — not read, list, or delete.
- **Authentication integrity**: Argon2id password hashing, timing-safe comparisons, dummy-hash-on-miss to prevent username enumeration, per-username rate limiting (10/15 min), `httpOnly` + `SameSite=strict` + `Secure` session cookies (Secure is gated on `PUBLIC_URL` being HTTPS, falling back to `NODE_ENV === 'production'`), JWT HS256 with a required `JWT_SECRET` that's length-AND-entropy-checked at startup.
- **Subprocess isolation**: `ffmpeg`, `ffprobe`, and WireGuard are spawned via argv arrays with explicit env — no shell, no inheritance of parent secrets beyond what each needs. Darkreel uploads run in-process (sealed-box crypto via Node's Web Crypto); there is no subprocess to leak environment variables.
- **Privilege-split VPN path**: in the Mullvad deployment, the Node process (and all its subprocesses — Playwright, Chromium, ffmpeg, ffprobe) runs as the unprivileged `ppvda` user. `CAP_NET_ADMIN`-requiring operations (wg-quick, ip route, `/etc/resolv.conf`, `/etc/hosts`) are handled by a separate Go helper (`wg-supervisor`) running as root, reached over a loopback Unix socket with `SO_PEERCRED` peer-uid authentication, a fixed four-operation RPC surface, and re-validation of every input on the privileged side. Chromium runs with its sandbox enabled (`chromiumSandbox: true`, with the `chromium-seccomp.json` profile in Docker), so a renderer bug first has to escape that sandbox. `SO_PEERCRED` cannot tell Node apart from Chromium or ffmpeg (same uid; ffmpeg is not sandboxed), so the supervisor does not let a caller widen what leaves the host outside the tunnel: the hosts that may bypass it are fixed when the container starts (`-bypass-hosts`, built by the entrypoint from `VPN_BYPASS_HOSTS` plus `api.mullvad.net`), and `ADD_ROUTES` accepts only names from that list, resolves them itself (IPv4 only, every address must be public unicast, pinned for the life of the container) and never takes addresses from the caller. Earlier versions routed whatever IPs the caller sent, so code running as `ppvda` could exempt an address of its choice from the kill switch and learn the server's real IP by connecting to it. Code execution as the `ppvda` uid — via a sandbox escape, or a bug in ffmpeg — cannot add a bypass of its choice, remove the kill-switch firewall, write the supervisor's config, or replace the RPC socket. It can still:
  - `TEARDOWN` the tunnel. This stays callable because a country switch is `TEARDOWN` + `BRINGUP`; the kill switch outlives it, so the effect is denial of service only — which the same uid can already cause by killing Node.
  - `BRINGUP` a tunnel to a relay endpoint of its choosing. The WireGuard handshake leaves from the real interface, so that endpoint learns the server's real IP. Closing this needs the supervisor to check relays against Mullvad's relay list itself; until then, treat code execution as `ppvda` as able to learn the real IP (though not to send extraction traffic outside the tunnel).

  The supervisor's WireGuard config lives in root-only `/run/wg-supervisor`, and the app code under `/app` is root-owned. Before this split, Chromium ran as root because the Node process needed `NET_ADMIN`, which auto-disabled Chromium's sandbox — a single renderer bug was then enough to reach root.
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

If `MULLVAD_ACCOUNT` is set, the Mullvad tunnel is brought up before the listener starts. The bypass hosts (`api.mullvad.net` and `VPN_BYPASS_HOSTS`) are resolved by `wg-supervisor` before the tunnel first comes up, using Docker's DNS, and routed around it; a host that couldn't be resolved then is retried at the next country switch through Mullvad's resolver, while the tunnel is still up. Two layers of defense follow:

1. **Network kill-switch** — before the tunnel first comes up, `wg-supervisor` installs an egress firewall in the container's network namespace (`PPVDA_KILLSWITCH` in iptables, `PPVDA_KILLSWITCH6` in ip6tables) that allows only loopback, `wg0`, the relay's WireGuard handshake, the bypass IPs, and replies to inbound connections. It is never removed — it stays in force across teardown, country switches and crashes of either process — and Docker's embedded DNS (which forwards to the host's resolver) is rejected. On teardown the default route becomes `unreachable` rather than reverting to the real gateway. `docker-compose.yml` also disables IPv6 in the container (the tunnel is IPv4-only). Country switches reuse the pinned bypass addresses and pick the relay before tearing the old tunnel down. If `/etc/resolv.conf` can't be pointed at Mullvad's resolver after bring-up, the tunnel is taken back down and the bring-up fails, instead of carrying on with Docker's resolver.
2. **Application kill-switch** — on startup, PPVDA runs initial interface + routing probes and refuses to serve traffic unless both pass. While running, it polls `/sys/class/net/wg0` every 5 s and curls `https://am.i.mullvad.net/connected` every 60 s; the probe's response body is never logged (when traffic is *not* going through Mullvad it names the server's real IP). Any persistent failure flips the in-process health flag, causing all `/extract*`, `/download*`, and `/stream-download*` routes (plus the background job pipeline) to return `503 VPN_KILL_SWITCH` until the tunnel recovers. See `src/mullvad/health.ts`.

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
2. Point `DOWNLOAD_DIR` at a tmpfs — e.g. `DOWNLOAD_DIR=/dev/shm/ppvda-downloads`, or a tmpfs mount for `/app/downloads` in `docker-compose.yml`. That backs both the finished-download directory and the `.tmp` staging directory inside it with RAM, so files never touch disk and are gone on reboot regardless of the overwrite pass.

   `/stream-download` and the job pipeline stage everything in private (0700) per-request directories under `$DOWNLOAD_DIR`, removed with secure overwrite when the request or job ends (on success and failure); leftovers from a crash are purged at startup.

   > Earlier revisions of this document recommended a `TEMP_DIR` environment variable. **No such variable exists** — PPVDA reads `DOWNLOAD_DIR` only, and setting `TEMP_DIR` silently does nothing. Use the settings above instead.

Without FDE, treat `secureUnlink` as a defence-in-depth speed bump against naïve disk recovery, not a forensic guarantee. The function is useful on ext4/xfs over a LUKS-encrypted rotational disk; on most other deployments its security contribution is marginal.

## Reporting a vulnerability

Email **baileywjohnson@gmail.com** with details. Please do not open a public issue for unfixed vulnerabilities. Include version, reproduction steps, and threat-model assumptions.

## Supported versions

Only the latest release tag is supported. `./update.sh` deploys only signed release tags (verified against `/etc/ppvda/allowed_signers`) and only as a fast-forward; `ppvda-deploy` requires a valid Ed25519 signature and fails closed without its key.

## Dependency hygiene

`npm audit --omit=dev --audit-level=high` runs on every push, PR, and weekly in CI (see `.github/workflows/security.yml`). A failing audit job against unchanged code usually signals a newly disclosed CVE — upgrade promptly.

## Future work

- Optional SQLCipher for at-rest DB encryption.
