# PPVDA -- Pretty Private Video Download Assistant

A privacy-focused service that extracts video URLs from web pages and downloads them. All traffic can be routed through a proxy or Mullvad VPN. No logs are kept about what is extracted or downloaded.

Optionally integrates with [Darkreel](https://github.com/baileywjohnson/darkreel) to automatically encrypt and upload downloaded videos to your encrypted media library.

## Features

- **Web UI** -- Paste a URL, track job progress in real time
- **Video extraction** -- Loads pages in headless Chromium, discovers video sources via network interception and DOM scanning
- **Video download** -- Supports HLS (.m3u8), DASH (.mpd), and direct file downloads, remuxing streams to MP4 via ffmpeg
- **Darkreel integration** -- Automatically encrypt and upload downloads to a Darkreel server via [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli)
- **Proxy support** -- Route all traffic through SOCKS4/5 or HTTP/HTTPS proxies
- **Mullvad VPN** -- Auto-configures a WireGuard tunnel inside Docker containers
- **Host filtering** -- Prefer, block, or whitelist video sources by domain
- **Concurrency control** -- Configurable parallel download limit (default: 3)
- **Privacy by design** -- No request logging, no URL logging, no download history

## Architecture

```
Browser  -->  PPVDA (your download server)  -->  Darkreel (your streaming server)
                |                                      |
   paste URL    |  extract + download + encrypt        |  encrypted storage
   view jobs    |  via proxy/VPN                       |  streaming to client
```

PPVDA is designed to run on a server in a privacy-friendly location (routed through VPN/proxy). Darkreel runs wherever you want low-latency streaming (e.g., a US VPS). The two servers communicate through the `darkreel-cli` tool, which encrypts files locally before uploading.

## Security: TLS Required

PPVDA does not handle TLS itself. **You must deploy it behind a TLS-terminating reverse proxy** (nginx, Caddy, etc.) or access it only over a secure tunnel (WireGuard, SSH). Without TLS, login credentials and session cookies are transmitted in plaintext.

## Quick start

### Prerequisites

- Node.js 20+
- ffmpeg
- Chromium (installed via Playwright)

### Setup

```bash
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env` and set at minimum:

```
PPVDA_PASSWORD=your-secure-password
```

### Run

```bash
npm run dev
```

Open `http://localhost:3000`, log in with `admin` / your password, and paste a video URL.

## Darkreel integration

To automatically encrypt and upload downloaded videos to a Darkreel server:

1. Install [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli#install) and make sure it's in your PATH (or set `DRK_BINARY_PATH`)

2. Add to your `.env`:

```
DARKREEL_SERVER=https://media.example.com
DARKREEL_USER=your-darkreel-username
DARKREEL_PASS=your-darkreel-password
```

3. Restart PPVDA. Downloads will now follow this pipeline:

   **extracting** --> **downloading** --> **encrypting** --> **done**

   The "encrypting" step runs `darkreel-cli upload`, which encrypts the file client-side and uploads it to your Darkreel server. The local file is deleted after a successful upload.

## Web UI

The web interface provides:

- **Login page** -- Simple username/password authentication
- **URL input** -- Paste a video page URL and submit
- **Job list** -- Real-time status updates via Server-Sent Events (SSE)
- **Status badges** -- Color-coded: extracting (blue), downloading (yellow), encrypting (purple), done (green), failed (red)

## API

All API endpoints (except `/health` and `/auth/login`) require authentication via Bearer token or session cookie.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login with username/password, returns JWT |
| POST | `/auth/logout` | Logout (clears session cookie) |

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jobs` | Submit a new download job |
| GET | `/jobs` | List all jobs |
| GET | `/jobs/:id` | Get job status |
| GET | `/jobs/events` | SSE stream for real-time job updates |

**POST /jobs body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | one of `url` or `videoUrl` | Page URL to extract from |
| `videoUrl` | string | one of `url` or `videoUrl` | Direct video URL (skips extraction) |
| `filename` | string | no | Output filename (max 200 chars) |
| `timeout` | number | no | Browser timeout in ms |

### Legacy endpoints

These endpoints from the original API still work (now require auth):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| POST | `/extract` | Extract video sources from a page (synchronous) |
| POST | `/download` | Download a video (synchronous) |

## Configuration

All configuration is via environment variables (or `.env` file).

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `DOWNLOAD_DIR` | `./downloads` | Where downloaded files are saved |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max parallel download jobs |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `PPVDA_USERNAME` | `admin` | Login username |
| `PPVDA_PASSWORD` | **(required)** | Login password |
| `JWT_SECRET` | random UUID | Secret for signing JWT tokens |

### Darkreel integration

| Variable | Default | Description |
|----------|---------|-------------|
| `DARKREEL_SERVER` | | Darkreel server URL (e.g., `https://media.example.com`) |
| `DARKREEL_USER` | | Darkreel username |
| `DARKREEL_PASS` | | Darkreel password |
| `DRK_BINARY_PATH` | `darkreel-cli` | Path to the darkreel-cli binary |
| `DRK_UPLOAD_TIMEOUT_MS` | `600000` | Max time for darkreel-cli upload (10 min) |

### Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_TIMEOUT_MS` | `30000` | Max time to wait for page load |
| `NETWORK_IDLE_MS` | `5000` | Wait for network idle before finishing extraction |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Max time for a download (5 min) |

### Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | | Proxy URL (e.g., `socks5://host:port`) |

### Host filtering

Comma-separated domain lists. Subdomain matching is supported (blocking `example.com` also blocks `cdn.example.com`).

| Variable | Description |
|----------|-------------|
| `PREFERRED_HOSTS` | Videos from these domains are sorted first in results |
| `BLOCKED_HOSTS` | Videos from these domains are excluded |
| `ALLOWED_HOSTS` | When set, **only** videos from these domains are returned |

### Mullvad VPN

For use in Docker. Sets up a WireGuard tunnel so all container traffic routes through Mullvad.

| Variable | Description |
|----------|-------------|
| `MULLVAD_ACCOUNT` | Mullvad account number |
| `MULLVAD_LOCATION` | Relay location -- country code (`se`) or country-city (`se-mma`, `us-nyc`) |
| `MULLVAD_CONFIG_DIR` | WireGuard config directory (default: `./mullvad`) |

### Jobs

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_JOB_HISTORY` | `100` | Max completed jobs to keep in memory |

## Docker

The Docker image includes ffmpeg, Chromium, WireGuard tools, and downloads the latest `darkreel-cli` binary automatically.

```bash
# Build and run
docker compose up --build

# Pin a specific darkreel-cli version
docker build --build-arg DARKREEL_CLI_VERSION=v1.0.0 -t ppvda .
```

### docker-compose.yml

The provided `docker-compose.yml` includes WireGuard support. Set your environment variables in `.env`:

```bash
# Required
PPVDA_PASSWORD=your-secure-password

# Optional: Darkreel integration
DARKREEL_SERVER=https://media.example.com
DARKREEL_USER=your-darkreel-username
DARKREEL_PASS=your-darkreel-password

# Optional: Mullvad VPN
MULLVAD_ACCOUNT=your-account-number
MULLVAD_LOCATION=se-mma
```

The container requires `NET_ADMIN` capability and `/dev/net/tun` for WireGuard (already configured in `docker-compose.yml`).

## Full deployment example

A typical setup with Darkreel on a US VPS and PPVDA on a privacy-friendly server:

### 1. US VPS: Darkreel

```bash
# On your US VPS
git clone https://github.com/baileywjohnson/darkreel.git
cd darkreel
go build -o darkreel .
./darkreel -addr :8080 -data /var/lib/darkreel
# Set up nginx reverse proxy with TLS (see Darkreel README)
```

Register an account via the web UI at `https://media.example.com`.

### 2. Download server: PPVDA

```bash
# On your download server (non-US, or with VPN)
git clone https://github.com/baileywjohnson/ppvda.git
cd ppvda

# Install darkreel-cli
curl -fSL -o /usr/local/bin/darkreel-cli \
  https://github.com/baileywjohnson/darkreel-cli/releases/latest/download/darkreel-cli-linux-amd64
chmod +x /usr/local/bin/darkreel-cli

# Configure
cp .env.example .env
# Edit .env:
#   PPVDA_PASSWORD=your-ppvda-password
#   DARKREEL_SERVER=https://media.example.com
#   DARKREEL_USER=your-darkreel-username
#   DARKREEL_PASS=your-darkreel-password

# Run with Docker (includes Mullvad VPN)
docker compose up --build
```

### 3. Use it

1. Open `http://your-download-server:3000`
2. Log in with your PPVDA credentials
3. Paste a video URL
4. Watch the job progress: extracting --> downloading --> encrypting --> done
5. Open `https://media.example.com` to stream your encrypted video

## Privacy

- Request logging is disabled -- no URLs appear in server logs
- Job objects never store URLs
- Error messages are sanitized to exclude URLs and network details
- VPN/proxy connection details are not logged
- No download history or metadata is persisted
- Downloaded files are deleted after successful upload to Darkreel

## Related projects

- [Darkreel](https://github.com/baileywjohnson/darkreel) -- E2E encrypted media server
- [darkreel-cli](https://github.com/baileywjohnson/darkreel-cli) -- Command-line upload tool for Darkreel

## License

MIT
