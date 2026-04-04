import { unlink } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { JobStore } from './store.js';
import type { DB } from '../db/index.js';
import type { SessionStore } from '../auth/sessions.js';
import type { ProxyConfig } from '../proxy/types.js';
import { extractVideos } from '../extractor/index.js';
import { downloadVideo, selectBestVideo } from '../downloader/index.js';
import { classifyUrl } from '../extractor/patterns.js';
import { uploadToDarkreel } from '../hooks/darkreel.js';
import { isVpnSwitching } from '../mullvad/index.js';
import { resolveProxy, type VpnPermissionStore } from '../server/vpn-permissions.js';
import { getUserDarkreelCreds } from '../server/routes/settings.js';
import type { VideoType, MediaType } from '../extractor/types.js';

export interface PipelineOpts {
  proxyConfig?: ProxyConfig;
  downloadDir: string;
  ffmpegPath: string;
  defaultTimeoutMs: number;
  defaultNetworkIdleMs: number;
  downloadTimeoutMs: number;
  preferredHosts: string[];
  blockedHosts: string[];
  allowedHosts: string[];
  maxConcurrentDownloads: number;
  drkBinaryPath: string;
  drkUploadTimeoutMs: number;
  vpnPermissions: VpnPermissionStore;
}

export interface Pipeline {
  submit(userId: string, input: { url?: string; videoUrl?: string; filename?: string; timeout?: number; useVpn?: boolean; autoPlay?: boolean }): Promise<string>;
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

  return {
    async submit(userId, input) {
      const job = store.create(userId);

      (async () => {
        await sem.acquire();
        try {
          await processJob(job.id, userId, input, store, opts, db, sessions, logger);
        } catch (err) {
          store.update(job.id, { status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' });
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
  const dbUser = db.getUserById(userId);
  const isAdmin = !!dbUser?.is_admin;
  const proxy = resolveProxy(input.useVpn, userId, isAdmin, opts.vpnPermissions, opts.proxyConfig);

  if (proxy && isVpnSwitching()) {
    store.update(jobId, { status: 'failed', error: 'VPN is switching countries, try again in a moment' });
    return;
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
  try {
    const result = await downloadVideo({
      url: targetUrl,
      type: targetType,
      outputDir: opts.downloadDir,
      filename: input.filename,
      timeoutMs: opts.downloadTimeoutMs,
      proxy,
      ffmpegPath: opts.ffmpegPath,
    });

    store.update(jobId, {
      fileSize: result.fileSize,
      durationSec: result.durationSec,
      format: result.format,
      filePath: result.filePath,
    });

    logger.info({ jobId }, 'Download complete');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err: errMsg }, 'Download failed');
    store.update(jobId, { status: 'failed', error: 'Download failed' });
    return;
  }

  // Step 3: Upload to Darkreel (if user has creds configured)
  const creds = getUserDarkreelCreds(db, sessions, userId);
  if (creds) {
    store.update(jobId, { status: 'encrypting' });

    const job = store.get(jobId);
    if (!job?.filePath) {
      store.update(jobId, { status: 'failed', error: 'No file path after download' });
      return;
    }

    try {
      const result = await uploadToDarkreel({
        drkBinaryPath: opts.drkBinaryPath,
        serverUrl: creds.server,
        username: creds.username,
        password: creds.password,
        filePath: job.filePath,
        timeoutMs: opts.drkUploadTimeoutMs,
      });

      if (result.success) {
        await unlink(job.filePath).catch(() => {});
        store.update(jobId, { status: 'done' });
        logger.info({ jobId }, 'Uploaded to Darkreel');
      } else {
        store.update(jobId, { status: 'failed', error: result.error ?? 'Darkreel upload failed' });
        logger.error({ jobId, err: result.error }, 'Darkreel upload failed');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      store.update(jobId, { status: 'failed', error: 'Darkreel upload failed' });
      logger.error({ jobId, err: errMsg }, 'Darkreel upload error');
    }
  } else {
    // No Darkreel configured — delete the local file (don't retain media on PPVDA)
    const job = store.get(jobId);
    if (job?.filePath) {
      await unlink(job.filePath).catch(() => {});
    }
    store.update(jobId, { status: 'done' });
  }
}
