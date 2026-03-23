import { runFfmpeg } from './ffmpeg.js';
import type { ProxyConfig } from '../proxy/types.js';

export interface HlsDownloadOptions {
  url: string;
  outputPath: string;
  ffmpegPath: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
}

/**
 * Download an HLS stream (.m3u8) and remux to MP4 via ffmpeg.
 */
export async function downloadHls(options: HlsDownloadOptions) {
  return runFfmpeg({
    inputUrl: options.url,
    outputPath: options.outputPath,
    ffmpegPath: options.ffmpegPath,
    proxyConfig: options.proxyConfig,
    timeoutMs: options.timeoutMs,
  });
}
