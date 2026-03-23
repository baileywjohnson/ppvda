# PPVDA — Pretty Private Video Download Assistant

A privacy-focused service that extracts video URLs from web pages and downloads them. All traffic can be routed through a proxy or Mullvad VPN. No logs are kept about what is extracted or downloaded.

## Features

- **Video extraction** — Loads pages in headless Chromium, discovers video sources via network interception and DOM scanning
- **Video download** — Supports HLS (.m3u8), DASH (.mpd), and direct file downloads, remuxing streams to MP4 via ffmpeg
- **Proxy support** — Route all traffic through SOCKS4/5 or HTTP/HTTPS proxies
- **Mullvad VPN** — Auto-configures a WireGuard tunnel inside Docker containers
- **Host filtering** — Prefer, block, or whitelist video sources by domain
- **Privacy by design** — No request logging, no URL logging, no download history

## Quick Start

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run dev
```

The server starts on `http://localhost:3000`.

## API

### `GET /health`

Health check.

### `POST /extract`

Extract video sources from a page.

```bash
curl -X POST http://localhost:3000/extract \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/page-with-video"}'
```

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Page URL to extract videos from |
| `timeout` | number | no | Browser timeout in ms (default: 30000) |

### `POST /download`

Download a video. Either provide a direct video URL or a page URL (extracts first, then downloads the best source).

```bash
# Download from a page (auto-extracts)
curl -X POST http://localhost:3000/download \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/page-with-video"}'

# Download a known video URL directly
curl -X POST http://localhost:3000/download \
  -H 'Content-Type: application/json' \
  -d '{"videoUrl": "https://example.com/video.mp4"}'
```

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | one of `url` or `videoUrl` | Page URL to extract from |
| `videoUrl` | string | one of `url` or `videoUrl` | Direct video URL (skips extraction) |
| `filename` | string | no | Output filename (max 200 chars) |
| `timeout` | number | no | Browser timeout in ms |

Downloads are saved to the configured `DOWNLOAD_DIR` (default: `./downloads`).

## Configuration

All configuration is via environment variables (or `.env` file).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `PROXY_URL` | | Proxy URL (e.g. `socks5://host:port`) |
| `DOWNLOAD_DIR` | `./downloads` | Where downloaded files are saved |
| `BROWSER_TIMEOUT_MS` | `30000` | Max time to wait for page load |
| `NETWORK_IDLE_MS` | `5000` | Wait for network idle before finishing extraction |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Max time for a download |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Max parallel downloads |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

### Host Filtering

Comma-separated domain lists. Subdomain matching is supported (blocking `example.com` also blocks `cdn.example.com`).

| Variable | Description |
|----------|-------------|
| `PREFERRED_HOSTS` | Videos from these domains are sorted first in results |
| `BLOCKED_HOSTS` | Videos from these domains are excluded |
| `ALLOWED_HOSTS` | When set, **only** videos from these domains are returned (overrides `BLOCKED_HOSTS`) |

### Mullvad VPN

For use in Docker. Sets up a WireGuard tunnel so all container traffic routes through Mullvad.

| Variable | Description |
|----------|-------------|
| `MULLVAD_ACCOUNT` | Mullvad account number |
| `MULLVAD_LOCATION` | Relay location — country code (`se`) or country-city (`se-mma`, `us-nyc`) |
| `MULLVAD_CONFIG_DIR` | WireGuard config directory (default: `./mullvad`) |

## Docker

```bash
# Without Mullvad
docker compose up --build

# With Mullvad — set in .env:
# MULLVAD_ACCOUNT=your-account-number
# MULLVAD_LOCATION=se-mma
docker compose up --build
```

The Docker container requires `NET_ADMIN` capability and `/dev/net/tun` for WireGuard (already configured in `docker-compose.yml`). Without Mullvad, you can run as a non-root user with `--user ppvda`.

## Privacy

- Request logging is disabled — no URLs appear in server logs
- Error messages are sanitized to exclude URLs and network details
- VPN/proxy connection details are not logged
- No download history or metadata is persisted
- The only evidence of a download is the file itself
