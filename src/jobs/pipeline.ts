import type { FastifyBaseLogger } from 'fastify';
import type { JobStore } from './store.js';
import type { DB } from '../db/index.js';
import type { SessionStore } from '../auth/sessions.js';
import type { ProxyConfig } from '../proxy/types.js';
import { extractVideos } from '../extractor/index.js';
import { downloadVideo, selectBestVideo, type DownloadResult } from '../downloader/index.js';
import { classifyUrl } from '../extractor/patterns.js';
import { uploadToDarkreel } from '../hooks/darkreel.js';
import { isVpnSwitching } from '../mullvad/index.js';
import { isVpnHealthy, isVpnKillSwitchEnabled } from '../mullvad/health.js';
import { isPrivateUrl } from '../utils/url.js';
import { secureRemoveDir, purgeStaleJobDirs } from '../utils/fs.js';
import { AppError } from '../utils/errors.js';
import { resolveProxy, type VpnPermissionStore } from '../server/vpn-permissions.js';
import { getUserDarkreelDelegation } from '../server/routes/settings.js';
import type { VideoType, MediaType } from '../extractor/types.js';

export interface PipelineOpts {
  proxyConfig?: ProxyConfig;
  downloadDir: string;
  ffmpegPath: string;
  defaultTimeoutMs: number;
  defaultNetworkIdleMs: number;
  downloadTimeoutMs: number;
  maxDownloadBytes: number;
  maxDownloadDurationSec: number;
  preferredHosts: string[];
  blockedHosts: string[];
  allowedHosts: string[];
  maxConcurrentDownloads: number;
  drkUploadTimeoutMs: number;
  vpnPermissions: VpnPermissionStore;
}

export interface Pipeline {
  submit(userId: string, input: { url?: string; videoUrl?: string; filename?: string; timeout?: number; useVpn?: boolean; autoPlay?: boolean }): Promise<string>;
}

/**
 * Cap on queued + running jobs per user, so one account can't monopolise
 * the shared download slots or push other users' queued jobs past the
 * stale-job sweep.
 */
const MAX_ACTIVE_JOBS_PER_USER = 10;

export class TooManyJobsError extends Error {
  constructor() {
    super(`Too many active jobs (limit ${MAX_ACTIVE_JOBS_PER_USER}) — wait for some to finish`);
  }
}

/** Simple semaphore for concurrency limiting */
class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve(); });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export function createPipeline(
  store: JobStore,
  opts: PipelineOpts,
  db: DB,
  sessions: SessionStore,
  logger: FastifyBaseLogger,
): Pipeline {
  const sem = new Semaphore(opts.maxConcurrentDownloads);

  // Nothing is running yet, so any job directory on disk is plaintext left
  // behind by a crash or restart.
  purgeStaleJobDirs(opts.downloadDir)
    .then((n) => { if (n > 0) logger.info({ count: n }, 'Purged stale job directories'); })
    .catch(() => {});

  return {
    async submit(userId, input) {
      if (store.activeCount(userId) >= MAX_ACTIVE_JOBS_PER_USER) {
        throw new TooManyJobsError();
      }
      const job = store.create(userId);

      (async () => {
        await sem.acquire();
        try {
          await processJob(job.id, userId, input, store, opts, db, sessions, logger);
        } catch (err) {
          // err.message is shown to the job's owner only; log nothing from it.
          store.update(job.id, { status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' });
          logger.error({ jobId: job.id, code: errorCode(err) }, 'Job failed');
        } finally {
          sem.release();
        }
      })();

      return job.id;
    },
  };
}

async function processJob(
  jobId: string,
  userId: string,
  input: { url?: string; videoUrl?: string; filename?: string; timeout?: number; useVpn?: boolean; autoPlay?: boolean },
  store: JobStore,
  opts: PipelineOpts,
  db: DB,
  sessions: SessionStore,
  logger: FastifyBaseLogger,
) {
  // The stale-job sweep may have failed this job while it sat in the queue.
  if (!store.isActive(jobId)) return;

  const dbUser = db.getUserById(userId);
  const isAdmin = !!dbUser?.is_admin;
  const proxy = resolveProxy(input.useVpn, userId, isAdmin, opts.vpnPermissions, opts.proxyConfig);

  if (proxy && isVpnSwitching()) {
    store.update(jobId, { status: 'failed', error: 'VPN is switching countries, try again in a moment' });
    return;
  }

  // Kill-switch check. If the tunnel is configured but unhealthy between job
  // submission and execution, fail the job rather than issue outbound requests
  // over a fallback route that would reveal the real source IP.
  if (isVpnKillSwitchEnabled() && !isVpnHealthy()) {
    store.update(jobId, { status: 'failed', error: 'VPN tunnel is not healthy — job blocked to prevent traffic leak' });
    return;
  }

  // Protocol and SSRF validation
  const urlToCheck = input.videoUrl ?? input.url;
  if (urlToCheck) {
    try {
      const protocol = new URL(urlToCheck).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') {
        store.update(jobId, { status: 'failed', error: 'Only http/https URLs are supported' });
        return;
      }
    } catch {
      store.update(jobId, { status: 'failed', error: 'Invalid URL' });
      return;
    }
    if (await isPrivateUrl(urlToCheck, { resolve: !proxy })) {
      store.update(jobId, { status: 'failed', error: 'Private/internal URLs are not allowed' });
      return;
    }
  }

  let targetUrl: string;
  let targetType: MediaType;

  // Step 1: Extract (if needed)
  if (input.videoUrl) {
    const match = classifyUrl(input.videoUrl, undefined, { includeImages: true });
    if (!match) {
      store.update(jobId, { status: 'failed', error: 'Could not determine media type' });
      return;
    }
    targetUrl = input.videoUrl;
    targetType = match.type;
    store.update(jobId, { status: 'downloading', videoType: match.type });
  } else if (input.url) {
    store.update(jobId, { status: 'extracting' });

    try {
      const extraction = await extractVideos({
        url: input.url,
        timeoutMs: input.timeout ?? opts.defaultTimeoutMs,
        networkIdleMs: opts.defaultNetworkIdleMs,
        proxy,
        preferredHosts: opts.preferredHosts,
        blockedHosts: opts.blockedHosts,
        allowedHosts: opts.allowedHosts,
        autoPlay: input.autoPlay,
      });

      if (extraction.videos.length === 0) {
        store.update(jobId, { status: 'failed', error: 'No videos found on the page' });
        return;
      }

      const best = selectBestVideo(extraction.videos);
      if (!best) {
        store.update(jobId, { status: 'failed', error: 'No suitable video found' });
        return;
      }

      targetUrl = best.url;
      targetType = best.type as MediaType;

      // SSRF: validate the resolved video URL (may differ from the page URL)
      if (await isPrivateUrl(targetUrl, { resolve: !proxy })) {
        store.update(jobId, { status: 'failed', error: 'Extracted video URL targets a private address' });
        return;
      }

      store.update(jobId, { status: 'downloading', videoType: best.type });
    } catch (err) {
      logger.error({ jobId }, 'Extraction failed');
      store.update(jobId, { status: 'failed', error: 'Extraction failed' });
      return;
    }
  } else {
    store.update(jobId, { status: 'failed', error: 'No URL provided' });
    return;
  }

  // Step 2: Download
  let download: DownloadResult;
  try {
    download = await downloadVideo({
      url: targetUrl,
      type: targetType,
      outputDir: opts.downloadDir,
      filename: input.filename,
      timeoutMs: opts.downloadTimeoutMs,
      maxBytes: opts.maxDownloadBytes,
      maxDurationSec: opts.maxDownloadDurationSec,
      proxy,
      ffmpegPath: opts.ffmpegPath,
    });

  } catch (err) {
    // Log the error code only: download error messages embed hostnames.
    logger.error({ jobId, code: errorCode(err) }, 'Download failed');
    store.update(jobId, { status: 'failed', error: downloadErrorMessage(err) });
    return;
  }

  // From here on the plaintext is on disk. The path is held in a local, not
  // read back from the job store: the store clears filePath the moment a job
  // turns terminal (and can evict the job outright), which previously
  // orphaned the file. The finally removes it on every exit path.
  try {
    store.update(jobId, {
      fileSize: download.fileSize,
      durationSec: download.durationSec,
      format: download.format,
    });
    logger.info({ jobId }, 'Download complete');

    if (!store.isActive(jobId)) return;
    await uploadStep(jobId, userId, isAdmin, download.filePath, store, opts, db, sessions, logger);
  } finally {
    await secureRemoveDir(download.workDir);
  }
}

async function uploadStep(
  jobId: string,
  userId: string,
  isAdmin: boolean,
  filePath: string,
  store: JobStore,
  opts: PipelineOpts,
  db: DB,
  sessions: SessionStore,
  logger: FastifyBaseLogger,
) {
  // Step 3: Upload to Darkreel (if the user has a Shape 2 delegation configured)
  const delegation = getUserDarkreelDelegation(db, sessions, userId);

  // Handle the three non-ok cases explicitly. Previously they were all
  // conflated as "Darkreel not configured, mark done" — which silently
  // turned session-expired and decrypt-failed jobs into phantom successes
  // (file deleted, job marked `done`, nothing arrives in Darkreel).
  if (delegation.state === 'session-expired' || delegation.state === 'decrypt-failed') {
    const msg = delegation.state === 'session-expired'
      ? 'Could not upload to Darkreel — your session expired mid-job. Log in and resubmit.'
      : 'Could not decrypt your Darkreel delegation. Reconnect Darkreel from Settings.';
    store.update(jobId, { status: 'failed', error: msg });
    logger.error({ jobId, state: delegation.state }, 'Darkreel delegation unavailable');
    return;
  }

  if (delegation.state === 'not-configured') {
    // No Darkreel configured — the caller's finally deletes the local file
    // (don't retain media on PPVDA)
    store.update(jobId, { status: 'done' });
    return;
  }

  // delegation.state === 'ok' — proceed with upload
  store.update(jobId, { status: 'encrypting' });

  try {
    const result = await uploadToDarkreel({
      conn: {
        serverUrl: delegation.serverUrl,
        userId: delegation.darkreelUserId,
        delegationId: delegation.delegationId,
        publicKey: delegation.publicKey,
        refreshToken: delegation.refreshToken,
      },
      admin: isAdmin,
      filePath,
      ffmpegPath: opts.ffmpegPath,
      timeoutMs: opts.drkUploadTimeoutMs,
    });

    if (result.success) {
      store.update(jobId, { status: 'done' });
      logger.info({ jobId }, 'Uploaded to Darkreel');
    } else {
      store.update(jobId, { status: 'failed', error: result.error ?? 'Darkreel upload failed' });
      logger.error({ jobId, code: result.code }, 'Darkreel upload failed');
    }
  } catch (err) {
    store.update(jobId, { status: 'failed', error: 'Darkreel upload failed' });
    logger.error({ jobId, code: errorCode(err) }, 'Darkreel upload error');
  }
}

/** Log-safe identifier for an error: its code, never its message. */
function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  return err instanceof Error ? err.name : 'UnknownError';
}

// User-facing text for the download failures worth distinguishing.
function downloadErrorMessage(err: unknown): string {
  const code = err instanceof AppError ? err.code : undefined;
  if (code === 'LIVE_STREAM') return 'Download failed — live streams are not supported';
  if (code === 'SIZE_EXCEEDED') return 'Download failed — file exceeds the maximum download size';
  if (code === 'DURATION_EXCEEDED') return 'Download failed — stream exceeds the maximum duration';
  return 'Download failed';
}
