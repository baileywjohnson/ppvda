import { unlink } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { JobStore } from './store.js';
import type { ProxyConfig } from '../proxy/types.js';
import { extractVideos } from '../extractor/index.js';
import { downloadVideo, selectBestVideo } from '../downloader/index.js';
import { classifyUrl } from '../extractor/patterns.js';
import { uploadToDarkreel } from '../hooks/darkreel.js';
import type { VideoType } from '../extractor/types.js';

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
  // Darkreel integration
  darkreelServer?: string;
  darkreelUser?: string;
  darkreelPass?: string;
  drkBinaryPath: string;
  drkUploadTimeoutMs: number;
}

export interface Pipeline {
  submit(input: { url?: string; videoUrl?: string; filename?: string; timeout?: number }): Promise<string>;
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

export function createPipeline(store: JobStore, opts: PipelineOpts, logger: FastifyBaseLogger): Pipeline {
  const darkreelEnabled = !!(opts.darkreelServer && opts.darkreelUser && opts.darkreelPass);
  const sem = new Semaphore(opts.maxConcurrentDownloads);

  return {
    async submit(input) {
      const job = store.create();

      // Fire and forget — process in background with concurrency limit
      (async () => {
        await sem.acquire();
        try {
          await processJob(job.id, input, store, opts, darkreelEnabled, logger);
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
  input: { url?: string; videoUrl?: string; filename?: string; timeout?: number },
  store: JobStore,
  opts: PipelineOpts,
  darkreelEnabled: boolean,
  logger: FastifyBaseLogger,
) {
  let targetUrl: string;
  let targetType: VideoType;

  // Step 1: Extract (if needed)
  if (input.videoUrl) {
    const match = classifyUrl(input.videoUrl);
    if (!match) {
      store.update(jobId, { status: 'failed', error: 'Could not determine video type' });
      return;
    }
    targetUrl = input.videoUrl;
    targetType = match.type;
    // Skip extracting state — go straight to downloading
    store.update(jobId, { status: 'downloading', videoType: match.type });
  } else if (input.url) {
    store.update(jobId, { status: 'extracting' });

    try {
      const extraction = await extractVideos({
        url: input.url,
        timeoutMs: input.timeout ?? opts.defaultTimeoutMs,
        networkIdleMs: opts.defaultNetworkIdleMs,
        proxy: opts.proxyConfig,
        preferredHosts: opts.preferredHosts,
        blockedHosts: opts.blockedHosts,
        allowedHosts: opts.allowedHosts,
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
      targetType = best.type as VideoType;
      store.update(jobId, { status: 'downloading', videoType: best.type });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId, err: errMsg }, 'Extraction failed');
      store.update(jobId, { status: 'failed', error: 'Extraction failed: ' + errMsg });
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
      proxy: opts.proxyConfig,
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
    store.update(jobId, { status: 'failed', error: 'Download failed: ' + errMsg });
    return;
  }

  // Step 3: Upload to Darkreel (if configured)
  if (darkreelEnabled) {
    store.update(jobId, { status: 'encrypting' });

    const job = store.get(jobId);
    if (!job?.filePath) {
      store.update(jobId, { status: 'failed', error: 'No file path after download' });
      return;
    }

    try {
      const result = await uploadToDarkreel({
        drkBinaryPath: opts.drkBinaryPath,
        serverUrl: opts.darkreelServer!,
        username: opts.darkreelUser!,
        password: opts.darkreelPass!,
        filePath: job.filePath,
        timeoutMs: opts.drkUploadTimeoutMs,
      });

      if (result.success) {
        // Delete local file after successful upload
        await unlink(job.filePath).catch(() => {});
        store.update(jobId, { status: 'done' });
        logger.info({ jobId }, 'Uploaded to Darkreel');
      } else {
        store.update(jobId, { status: 'failed', error: result.error ?? 'Darkreel upload failed' });
        logger.error({ jobId }, 'Darkreel upload failed');
      }
    } catch (err) {
      store.update(jobId, { status: 'failed', error: 'Darkreel upload failed' });
      logger.error({ jobId }, 'Darkreel upload error');
    }
  } else {
    store.update(jobId, { status: 'done' });
  }
}
