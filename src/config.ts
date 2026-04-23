import dotenv from 'dotenv';

dotenv.config();

// JWT_SECRET is required in every environment. A dev-only ephemeral fallback
// masks deployment misconfiguration — if NODE_ENV is unset or ambiguous, a
// production instance would silently generate a random secret, issue tokens,
// and invalidate them on the next restart. Requiring it up-front surfaces the
// problem at startup instead of in production.
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is required. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  // Length alone is a weak check — "a" * 32 passes. Require reasonable entropy
  // so operators who set placeholder secrets (repeated characters, sequential
  // letters) get a loud startup failure instead of silently-forgeable tokens.
  if (shannonEntropyBits(secret) < 3.0) {
    throw new Error(
      'JWT_SECRET is too low-entropy. Use a random string from:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return secret;
}

// Shannon entropy in bits per character. Pure random base64/hex output is
// 4-6 bits/char. "aaaaaaaa..." is 0. A threshold of 3.0 bits/char flags
// placeholder strings while still accepting hex (4 bits/char) and base64.
function shannonEntropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface AppConfig {
  port: number;
  host: string;
  publicUrl: string | undefined;
  proxyUrl: string | undefined;
  downloadDir: string;
  browserTimeoutMs: number;
  networkIdleMs: number;
  downloadTimeoutMs: number;
  maxDownloadBytes: number;
  ffmpegPath: string;
  maxConcurrentDownloads: number;
  logLevel: string;
  mullvadAccount: string | undefined;
  mullvadLocation: string | undefined;
  mullvadConfigDir: string;
  vpnBypassHosts: string[];
  preferredHosts: string[];
  blockedHosts: string[];
  allowedHosts: string[];
  // Auth + DB
  jwtSecret: string;
  dbPath: string;
  adminUsername: string;
  adminPassword: string;
  // Darkreel (per-user delegations in DB, no subprocess binary anymore)
  drkUploadTimeoutMs: number;
  // Jobs
  maxJobHistory: number;
  // Features
  enableThumbnails: boolean;
}

function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function loadConfig(): AppConfig {
  return Object.freeze({
    port: parseInt(process.env.PORT ?? '3000', 10),
    host: process.env.HOST ?? '0.0.0.0',
    publicUrl: process.env.PUBLIC_URL || undefined,
    proxyUrl: process.env.PROXY_URL || undefined,
    downloadDir: process.env.DOWNLOAD_DIR ?? './downloads',
    browserTimeoutMs: parseInt(process.env.BROWSER_TIMEOUT_MS ?? '30000', 10),
    networkIdleMs: parseInt(process.env.NETWORK_IDLE_MS ?? '2000', 10),
    downloadTimeoutMs: parseInt(process.env.DOWNLOAD_TIMEOUT_MS ?? '300000', 10),
    // 10 GB default — high enough for long-form video, low enough to prevent
    // disk exhaustion from an infinite/misconfigured upstream response.
    maxDownloadBytes: parseInt(process.env.MAX_DOWNLOAD_BYTES ?? String(10 * 1024 * 1024 * 1024), 10),
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS ?? '3', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    mullvadAccount: process.env.MULLVAD_ACCOUNT || undefined,
    mullvadLocation: process.env.MULLVAD_LOCATION || undefined,
    mullvadConfigDir: process.env.MULLVAD_CONFIG_DIR ?? './mullvad',
    vpnBypassHosts: parseHostList(process.env.VPN_BYPASS_HOSTS),
    preferredHosts: parseHostList(process.env.PREFERRED_HOSTS),
    blockedHosts: parseHostList(process.env.BLOCKED_HOSTS),
    allowedHosts: parseHostList(process.env.ALLOWED_HOSTS),
    // Auth + DB
    jwtSecret: getJwtSecret(),
    dbPath: process.env.DB_PATH ?? './data/ppvda.db',
    adminUsername: process.env.PPVDA_ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.PPVDA_ADMIN_PASSWORD ?? '',
    // Darkreel
    drkUploadTimeoutMs: parseInt(process.env.DRK_UPLOAD_TIMEOUT_MS ?? '600000', 10),
    // Jobs
    maxJobHistory: parseInt(process.env.MAX_JOB_HISTORY ?? '100', 10),
    // Features
    enableThumbnails: process.env.ENABLE_THUMBNAILS !== 'false',
  });
}
