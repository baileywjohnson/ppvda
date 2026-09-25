# Security

## Threat model

PPVDA is a privacy-focused video extractor/downloader. It runs a headless Chromium against user-supplied URLs and optionally uploads results to a [Darkreel](https://github.com/baileywjohnson/darkreel) server for encrypted archival.

### In scope

- **SSRF defense**: user-supplied URLs cannot target RFC1918, loopback, link-local, cloud-metadata, or IPv6 private ranges, *including* obfuscated IPv4 encodings. Defense is layered so every outbound egress hits a validator the HTTP client cannot bypass:
  - **Route-level checks** reject private / obfuscated addresses up front.
  - **Node download paths** (direct downloads, image proxy) use DNS pinning — one `safeResolveHost` call resolves + validates, the address is pinned into `http.get`'s `lookup` option, the client never re-resolves. Closes the DNS-rebinding window between check and connect. Redirect hops recurse through the same pinned flow.
  - **ffmpeg / ffprobe** go through a loopback-only forward proxy (per-invocation, random port, closed on exit). Every `CONNECT` and absolute-URI request is validated via `safeResolveHost` before the tunnel opens — so HLS/DASH segment URIs ffmpeg fetches autonomously can't reach private IPs either.
  - **Chromium** uses the same SSRF proxy for all of its traffic (Playwright forces loopback through it too), so DNS names that resolve to private addresses, redirects, subresources and requests from page JS are all validated. `--host-rules` stays as defense in depth. WebRTC is limited to proxied connections and QUIC is disabled.
  - `file://` is removed from the ffmpeg/ffprobe `-protocol_whitelist` so a user-influenced URL can't be redirected into local-file-read. Files PPVDA downloaded are re-read only with `-protocol_whitelist file` and a demuxer forced from their magic bytes (no playlist, concat or image-sequence demuxers).
  - Addresses routed around the VPN (`VPN_BYPASS_HOSTS`, the Mullvad API) are refused as extraction targets, so a URL whose host shares one of those IPs can't be fetched outside the tunnel.
  - With `PROXY_URL`, the SSRF proxy chains to the operator's proxy: literal-host checks apply locally and names are resolved by the upstream proxy (never by this host's resolver). ffmpeg only understands `http://` proxies, so handing it the upstream URL directly — as earlier versions did — made it ignore a SOCKS/https proxy and connect from the real IP.
- **Credential confidentiality**: PPVDA no longer holds any Darkreel password. Connect runs a delegation exchange (copy-paste authorization code) that returns an upload-scoped refresh token + the user's Darkreel X25519 public key; PPVDA refuses any broader scope and stores only those two, with the refresh token AES-256-GCM-encrypted at rest under the user's PPVDA master key (AAD = user ID). A full PPVDA compromise grants *upload-only* capability to each connected Darkreel account — not read, list, or delete of what is already there. It can't produce Darkreel's owner tag either, so everything PPVDA uploads (legitimate or not) is marked **APP** in Darkreel's gallery. The key PPVDA seals to is shown as a SHA-256 fingerprint for the user to compare with Darkreel's, which catches a public key swapped in transit at connect time.
- **Authentication integrity**: Argon2id password hashing, timing-safe comparisons, dummy-hash-on-miss to prevent username enumeration (recovery for an unknown user costs the same as a wrong code), per-username limits on *failed* attempts (10 per 15 min, separate for login and recovery, keyed by a hash of the username), length caps on usernames and passwords, the admin flag read from the database on every request rather than from the JWT, `httpOnly` + `SameSite=strict` + `Secure` session cookies (Secure is gated on `PUBLIC_URL` being HTTPS, falling back to `NODE_ENV === 'production'`), JWT HS256 with a required `JWT_SECRET` that's length-AND-entropy-checked at startup.
- **Subprocess isolation**: `ffmpeg`, `ffprobe`, Chromium and WireGuard are spawned via argv arrays with explicit, minimal env — no shell, no inheritance of parent secrets (`JWT_SECRET`, `MULLVAD_ACCOUNT`, the bootstrap password). Darkreel uploads run in-process (sealed-box crypto via Node's `crypto` module); there is no subprocess to leak environment variables.
- **Privilege-split VPN path**: in the Mullvad deployment, the Node process (and all its subprocesses — Playwright, Chromium, ffmpeg, ffprobe) runs as the unprivileged `ppvda` user. `CAP_NET_ADMIN`-requiring operations (wg-quick, ip route, `/etc/resolv.conf`, `/etc/hosts`) are handled by a separate Go helper (`wg-supervisor`) running as root, reached over a Unix socket (in `root:ppvda 0750` `/run/ppvda`) with `SO_PEERCRED` peer-uid authentication, a fixed four-operation RPC surface, and re-validation of every input on the privileged side. Chromium runs with its sandbox enabled (`chromiumSandbox: true`, with the `chromium-seccomp.json` profile and `no-new-privileges` in Docker; `CHROMIUM_SANDBOX=false` turns it off), so a renderer bug first has to escape that sandbox. `SO_PEERCRED` cannot tell Node apart from Chromium or ffmpeg (same uid; ffmpeg is not sandboxed), so the supervisor does not let a caller widen what leaves the host outside the tunnel: the hosts that may bypass it are fixed when the container starts (`-bypass-hosts`, built by the entrypoint from `VPN_BYPASS_HOSTS` plus `api.mullvad.net`), and `ADD_ROUTES` accepts only names from that list, resolves them itself (IPv4 only, every address must be public unicast, pinned for the life of the container) and never takes addresses from the caller. Earlier versions routed whatever IPs the caller sent, so code running as `ppvda` could exempt an address of its choice from the kill switch and learn the server's real IP by connecting to it. Code execution as the `ppvda` uid — via a sandbox escape, or a bug in ffmpeg — cannot add a bypass of its choice, remove the kill-switch firewall, write the supervisor's config, or replace the RPC socket. It can still:
  - `TEARDOWN` the tunnel. This stays callable because a country switch is `TEARDOWN` + `BRINGUP`; the kill switch outlives it, so the effect is denial of service only — which the same uid can already cause by killing Node.
  - `BRINGUP` a tunnel — but only to a genuine Mullvad WireGuard relay. Before touching the kill switch, routes or config, the supervisor checks the peer against Mullvad's relay list, which it fetches itself from the fixed URL `https://api.mullvad.net/app/v1/relays`, connecting only to the addresses it pinned for `api.mullvad.net` and verifying the certificate for that name against the system roots (no proxy, no redirects, response capped at 8 MiB, cached for 10 minutes; a rejection against a list older than a minute triggers one refetch). The public key, the endpoint IPv4 (`ipv4_addr_in`) and the port (within the list's WireGuard `port_ranges`) must all match one active relay in the list's `wireguard` section, `relayIP` must be the endpoint's address, the tunnel address must be a /32 in Mullvad's `10.64.0.0/10`, and the resolver is always `10.64.0.1`. Anything else — or a list that can't be fetched — is refused, and a refused endpoint never reaches the kill switch. Earlier versions accepted any endpoint, so code running as `ppvda` could point the handshake (and all tunneled traffic) at a host it controlled and learn the real IP. What remains is choosing *which* listed relay (the same freedom as the admin country switch) and which private key (an unregistered key just means no connectivity), so the effect is denial of service, not disclosure. Because the check fetches over the `api.mullvad.net` bypass, that host must be routed (`ADD_ROUTES`) before `BRINGUP`; if it couldn't be, the tunnel doesn't come up.

  The supervisor's WireGuard config lives in root-only `/run/wg-supervisor` (written without following symlinks, overwritten on teardown), and the app code under `/app` is root-owned. Apart from the supervisor, such code has everything the `ppvda` user has — treat it as a live compromise of PPVDA (see Out of scope). Before this split, Chromium ran as root because the Node process needed `NET_ADMIN`, which auto-disabled Chromium's sandbox — a single renderer bug was then enough to reach root.
- **No persistent PII**: URLs are not logged, downloads live on disk only in per-job/per-request directories that are removed when the job or request ends (see [Temp-file plaintext at rest](#temp-file-plaintext-at-rest)), and no download history is retained.

### Out of scope

- **Browser-level zero-days in the bundled Chromium**. Playwright ships a pinned Chromium version; a zero-day against it is exploitable against any user-supplied page. See the `CVE tracking` section below for the live list. **PPVDA navigates arbitrary URLs, so this is a real and ongoing risk.**
- **A live compromise of PPVDA** — of the Node process, or code running as the `ppvda` uid. It sees what PPVDA handles: users' passwords as they log in, the master keys of logged-in users, submitted URLs, and every downloaded file in plaintext before it is encrypted; it can read the database and use the connected Darkreel delegations (upload-only). The privilege split and kill switch limit what it can do to the network, not what it can read.
- **Compromise of the VPN layer itself** (e.g., Mullvad egress bugs, WireGuard cryptographic failures). The kill switches (see below) guard against tunnel failure but not against a successfully established tunnel that is itself compromised.
- **Compromise of the Darkreel server**. PPVDA uploads go out sealed to the user's X25519 public key, so a compromised Darkreel server sees ciphertext and opaque sealed keys only. A hostile server could still refuse uploads, or hand out a different public key at connect time — which the fingerprint check above is for. PPVDA caps its responses at 64 KB, shape-checks them and doesn't follow redirects.
- **Local attackers with shell access to the PPVDA host**. SQLite is unencrypted at rest; user Argon2 hashes are on disk. Pair with LUKS / FileVault / SQLCipher if backup theft is in your threat model.

## Deployment requirements

### Required environment variables

- `JWT_SECRET` — 32+ character random string. Required in **every** environment (no dev fallback). Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `PPVDA_ADMIN_PASSWORD` — required on first launch only, for admin bootstrap. Must pass `isStrongPassword` (16+ chars, letter + digit + symbol, no spaces). The bootstrap writes a one-time recovery code to `<data-dir>/admin-recovery-code.txt` (chmod 0600). Read it, save it elsewhere, then delete the file. PPVDA warns on every subsequent startup while the file exists.

### Reverse proxy posture

PPVDA trusts `X-Forwarded-For` from loopback and private (RFC1918 / IPv6 ULA) peers, which is what Caddy on the host looks like through Docker's bridge; per-IP rate limits then apply to the real client. That is only safe while port 3000 is unreachable except through your proxy — `docker-compose.yml` publishes it on host loopback only. If clients on a private network can reach port 3000 directly, they can set `X-Forwarded-For` and evade the per-IP limits (the per-username limits still apply).

### VPN configuration

If `MULLVAD_ACCOUNT` is set, the Mullvad tunnel is brought up before the listener starts, and startup fails if it can't be (including when Mullvad's relay list can't be fetched to check the relay). The bypass hosts (`api.mullvad.net` and `VPN_BYPASS_HOSTS`) are resolved by `wg-supervisor` before the tunnel first comes up, using Docker's DNS, and routed around it; a host that couldn't be resolved then is retried at the next country switch through Mullvad's resolver, while the tunnel is still up. Two layers of defense follow:

1. **Network kill-switch** — before the tunnel first comes up, `wg-supervisor` installs an egress firewall in the container's network namespace (`PPVDA_KILLSWITCH` in iptables, `PPVDA_KILLSWITCH6` in ip6tables) that allows only loopback, `wg0`, the relay's WireGuard handshake, the bypass IPs, and replies to inbound connections. It is never removed — it stays in force across teardown, country switches and crashes of either process — and Docker's embedded DNS (which forwards to the host's resolver) is rejected. On teardown the default route becomes `unreachable` rather than reverting to the real gateway. `docker-compose.yml` also disables IPv6 in the container (the tunnel is IPv4-only). Country switches reuse the pinned bypass addresses and pick the relay before tearing the old tunnel down. If `/etc/resolv.conf` can't be pointed at Mullvad's resolver after bring-up, the tunnel is taken back down and the bring-up fails, instead of carrying on with Docker's resolver.
2. **Application kill-switch** — on startup, PPVDA runs initial interface + routing probes and refuses to serve traffic unless both pass. While running, it checks `/sys/class/net/wg0` every 5 s and fetches `https://am.i.mullvad.net/connected` every 60 s; the probe's response body is never logged (when traffic is *not* going through Mullvad it names the server's real IP). Any persistent failure flips the in-process health flag, causing `/extract`, `/extract/stream`, `/stream-download` and `/thumbnail` to return `503 VPN_KILL_SWITCH` (and queued jobs to fail) until the tunnel recovers. See `src/mullvad/health.ts`.

The application kill-switch is a no-op when `MULLVAD_ACCOUNT` is unset (bare deploy): routes behave as plain authenticated endpoints.

### Playwright CVE tracking

Playwright ships a pinned Chromium. When a Chromium CVE affects navigation (particularly CVEs affecting renderer, CSS, or JS engines), PPVDA is affected until the Playwright team tags a release containing the Chromium roll. Dependabot (see `.github/dependabot.yml`) opens a PR for every Playwright release so Chromium security rolls land as their own reviewable change — upgrade these promptly. The current Chromium version can be checked in `package-lock.json`; compare against [chromereleases.googleblog.com](https://chromereleases.googleblog.com/).

### Database at rest

SQLite at `./data/ppvda.db` (`/app/data` in Docker) is unencrypted by default. It contains usernames, Argon2 hashes, encrypted master keys, and Darkreel delegations (refresh token AES-256-GCM-encrypted under the user's master key; server URL and public key in the clear). `setup.sh`'s daily backups are encrypted with a key kept on the same host. If backup theft is part of your threat model, either:
- deploy on a LUKS / FileVault / encrypted-EBS host, or
- swap `better-sqlite3` for `better-sqlite3-multiple-ciphers` and configure a cipher key passed via a secret manager.

`secure_delete = ON` is enabled, so deleted rows (including disconnected delegations and deleted users) are zeroed before the page is reused — not just marked free in the btree. The WAL is checkpointed and truncated every 5 minutes and on shutdown.

### Temp-file plaintext at rest

Downloaded video files live briefly in `DOWNLOAD_DIR` (default `./downloads/`; `docker-compose.yml` bind-mounts the host's `./downloads`, so by default that is disk) as plaintext before being encrypted and shipped to Darkreel (or deleted if no delegation is configured). `secureUnlink` overwrites each file with random bytes and datasyncs before unlinking (including the fragmented-MP4 copy remuxed for upload) but on modern filesystems this overwrite **does not reliably reach the original blocks**:

- **Copy-on-write filesystems** (Btrfs, ZFS, APFS, XFS reflinks): an overwrite allocates a new block; the original blocks keep the plaintext until the FS garbage-collects them.
- **SSDs / NVMe**: wear-levelling scatters writes across flash pages — the "same LBA" may map to completely different physical pages before vs after the overwrite. The plaintext page is still flagged as garbage in the FTL but not erased until the next TRIM + block erase.
- **Log-structured / journaling filesystems** retain historical page contents in the journal.

To actually get forensic resistance on the temp-file surface, you need **full-disk encryption plus an ephemeral tmpfs**:

1. Run the host/container on LUKS / FileVault / encrypted EBS (also covers the SQLite DB — see above).
2. Point `DOWNLOAD_DIR` at a tmpfs — e.g. `DOWNLOAD_DIR=/dev/shm/ppvda-downloads`, or a tmpfs mount for `/app/downloads` in `docker-compose.yml`. Everything PPVDA writes while downloading (downloads, remuxes, upload thumbnails) is staged under it, so files never touch disk and are gone on reboot regardless of the overwrite pass.

   `/stream-download` and the job pipeline stage everything in private (0700) per-request/per-job directories under `$DOWNLOAD_DIR`, removed with secure overwrite when the request or job ends (on success and failure); leftovers from a crash are purged at startup.

   > Earlier revisions of this document recommended a `TEMP_DIR` environment variable. PPVDA doesn't read it — only `DOWNLOAD_DIR` matters. Use the settings above instead.

Without FDE, treat `secureUnlink` as a defence-in-depth speed bump against naïve disk recovery, not a forensic guarantee. The function is useful on ext4/xfs over a LUKS-encrypted rotational disk; on most other deployments its security contribution is marginal.

## Reporting a vulnerability

Email **baileywjohnson@gmail.com** with details. Please do not open a public issue for unfixed vulnerabilities. Include version, reproduction steps, and threat-model assumptions.

## Supported versions

Only the latest release tag is supported. `./update.sh` deploys only signed release tags (verified against `/etc/ppvda/allowed_signers`) and only as a fast-forward; `ppvda-deploy` requires a valid Ed25519 signature over the commit hash (`/etc/ppvda/signing.pub`), refuses commits that don't descend from what is running, and fails closed without its key. `setup.sh` builds the newest signed release when a signer is pinned; otherwise it builds the checkout and warns that it is unverified.

## Dependency hygiene

`npm audit --omit=dev --audit-level=high` runs on every push, PR, and weekly in CI (see `.github/workflows/security.yml`). A failing audit job against unchanged code usually signals a newly disclosed CVE — upgrade promptly.

## Future work

- Optional SQLCipher for at-rest DB encryption.
