import { join } from 'node:path';
import { generateId } from '../utils/id.js';
import { ensureDir, tempPath, moveFile, fileSize, secureUnlink } from '../utils/fs.js';
import { DownloadError } from '../utils/errors.js';
import { downloadDirect } from './direct.js';
import { downloadHls } from './hls.js';
import { downloadDash } from './dash.js';
import type { ProxyConfig } from '../proxy/types.js';
import type { DownloadOptions, DownloadResult } from './types.js';

export type { DownloadOptions, DownloadResult } from './types.js';

interface FullDownloadOptions extends DownloadOptions {
  proxy?: ProxyConfig;
  ffmpegPath?: string;
  tempDir?: string;
}

/**
 * Download a video from a discovered source URL.
 * Routes to the correct handler based on video type.
 */
export async function downloadVideo(options: FullDownloadOptions): Promise<DownloadResult> {
  const {
    url,
    type,
    outputDir,
    filename,
    timeoutMs = 300000,
    maxBytes,
    proxy,
    ffmpegPath = 'ffmpeg',
    tempDir,
  } = options;
  const effectiveTempDir = tempDir ?? join(outputDir, '.tmp');

  const id = generateId();
  const ext = type === 'image' ? extFromUrl(url, '.jpg') : type === 'direct' ? extFromUrl(url) : '.mp4';
  const finalFilename = sanitizeFilename(filename ?? filenameFromUrl(url)) + ext;
  const finalPath = join(outputDir, finalFilename);
  const tmpPath = tempPath(effectiveTempDir, id, ext);

  await ensureDir(outputDir);
  await ensureDir(effectiveTempDir);

  try {
    let durationSec: number | undefined;

    switch (type) {
      case 'hls': {
        const result = await downloadHls({
          url,
          outputPath: tmpPath,
          ffmpegPath,
          proxyConfig: proxy,
          timeoutMs,
        });
        durationSec = result.durationSec;
        break;
      }
      case 'dash': {
        const result = await downloadDash({
          url,
          outputPath: tmpPath,
          ffmpegPath,
          proxyConfig: proxy,
          timeoutMs,
        });
        durationSec = result.durationSec;
        break;
      }
      case 'direct':
      case 'image': {
        await downloadDirect({
          url,
          outputPath: tmpPath,
          proxyConfig: proxy,
          timeoutMs,
          maxBytes,
        });
        break;
      }
      default:
        throw new DownloadError(`Unknown media type: ${type}`, 'UNKNOWN_TYPE');
    }

    // Atomic move from temp to final destination
    await moveFile(tmpPath, finalPath);
    const size = await fileSize(finalPath);

    return {
      id,
      filePath: finalPath,
      fileSize: size,
      durationSec,
      format: ext.replace('.', ''),
      success: true,
    };
  } catch (err) {
    // Securely clean up temp file on failure
    await secureUnlink(tmpPath);
    throw err;
  }
}

function extFromUrl(url: string, fallback = '.mp4'): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot !== -1) {
      const ext = pathname.substring(dot).toLowerCase();
      if (ext.length <= 6) return ext;
    }
  } catch {}
  return fallback;
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      // Remove extension, it will be added back
      const dot = last.lastIndexOf('.');
      return dot !== -1 ? last.substring(0, dot) : last;
    }
  } catch {}
  return `video-${generateId(6)}`;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

/**
 * Select the "best" video from a list of sources.
 * Prefers HLS > DASH > direct, and higher quality indicators.
 */
export function selectBestVideo(
  videos: Array<{ url: string; type: string; quality?: string }>,
): typeof videos[number] | null {
  if (videos.length === 0) return null;

  const typeOrder: Record<string, number> = { hls: 0, dash: 1, direct: 2 };

  const sorted = [...videos].sort((a, b) => {
    // Sort by type preference
    const typeA = typeOrder[a.type] ?? 3;
    const typeB = typeOrder[b.type] ?? 3;
    if (typeA !== typeB) return typeA - typeB;

    // Sort by quality (higher resolution first)
    const qualA = parseQuality(a.quality);
    const qualB = parseQuality(b.quality);
    return qualB - qualA;
  });

  return sorted[0];
}

function parseQuality(q: string | undefined): number {
  if (!q) return 0;
  const match = q.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}
