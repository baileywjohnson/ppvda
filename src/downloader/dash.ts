import { runFfmpeg } from './ffmpeg.js';
import type { ProxyConfig } from '../proxy/types.js';

export interface DashDownloadOptions {
  url: string;
  outputPath: string;
  ffmpegPath: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
}

/**
 * Download a DASH stream (.mpd) and remux to MP4 via ffmpeg.
 */
export async function downloadDash(options: DashDownloadOptions) {
  return runFfmpeg({
    inputUrl: options.url,
    outputPath: options.outputPath,
    ffmpegPath: options.ffmpegPath,
    proxyConfig: options.proxyConfig,
    timeoutMs: options.timeoutMs,
  });
}
