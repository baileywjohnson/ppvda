import { spawn } from 'node:child_process';
import type { ProxyConfig } from '../proxy/types.js';
import { getFfmpegEnv } from '../proxy/index.js';

export interface ProbeResult {
  durationSec?: number;
  width?: number;
  height?: number;
  fileSize?: number;
}

/**
 * Use ffprobe to get metadata about a video URL without downloading it.
 * Works for direct files, HLS manifests, and DASH manifests.
 */
export async function probeVideo(options: {
  url: string;
  ffprobePath?: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const {
    url,
    ffprobePath = 'ffprobe',
    proxyConfig,
    timeoutMs = 10000,
  } = options;

  // Block non-HTTP protocols to prevent file://, gopher://, concat: etc.
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return {};
  } catch {
    return {};
  }

  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-select_streams', 'v:0',
    url,
  ];

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  if (proxyConfig) {
    Object.assign(env, getFfmpegEnv(proxyConfig));
  }

  return new Promise<ProbeResult>((resolve) => {
    const proc = spawn(ffprobePath, args, {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let stdout = '';

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({});
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({});
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const result: ProbeResult = {};

        // Duration from format or stream
        const duration = parseFloat(data.format?.duration) || parseFloat(data.streams?.[0]?.duration);
        if (duration && isFinite(duration)) {
          result.durationSec = Math.round(duration);
        }

        // Resolution from first video stream
        const stream = data.streams?.[0];
        if (stream?.width && stream?.height) {
          result.width = stream.width;
          result.height = stream.height;
        }

        // File size (only available for direct files, not streams)
        const size = parseInt(data.format?.size, 10);
        if (size && isFinite(size)) {
          result.fileSize = size;
        }

        resolve(result);
      } catch {
        resolve({});
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

/** Derive a quality label from resolution (e.g., "1080p", "720p") */
export function qualityFromResolution(width?: number, height?: number): string | undefined {
  if (!height) return undefined;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return `${height}p`;
}
