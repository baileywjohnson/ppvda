import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

dotenv.config();

export interface AppConfig {
  port: number;
  host: string;
  proxyUrl: string | undefined;
  downloadDir: string;
  browserTimeoutMs: number;
  networkIdleMs: number;
  downloadTimeoutMs: number;
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
  // Darkreel (server-wide settings, creds are per-user in DB)
  drkBinaryPath: string;
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
    proxyUrl: process.env.PROXY_URL || undefined,
    downloadDir: process.env.DOWNLOAD_DIR ?? './downloads',
    browserTimeoutMs: parseInt(process.env.BROWSER_TIMEOUT_MS ?? '30000', 10),
    networkIdleMs: parseInt(process.env.NETWORK_IDLE_MS ?? '2000', 10),
    downloadTimeoutMs: parseInt(process.env.DOWNLOAD_TIMEOUT_MS ?? '300000', 10),
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
    jwtSecret: process.env.JWT_SECRET || randomUUID(),
    dbPath: process.env.DB_PATH ?? './data/ppvda.db',
    adminUsername: process.env.PPVDA_ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.PPVDA_ADMIN_PASSWORD ?? '',
    // Darkreel
    drkBinaryPath: process.env.DRK_BINARY_PATH ?? 'darkreel-cli',
    drkUploadTimeoutMs: parseInt(process.env.DRK_UPLOAD_TIMEOUT_MS ?? '600000', 10),
    // Jobs
    maxJobHistory: parseInt(process.env.MAX_JOB_HISTORY ?? '100', 10),
    // Features
    enableThumbnails: process.env.ENABLE_THUMBNAILS === 'true',
  });
}
