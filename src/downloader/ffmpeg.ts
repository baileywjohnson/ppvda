import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { FfmpegError, TimeoutError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getFfmpegEnv } from '../proxy/index.js';

export interface FfmpegOptions {
  inputUrl: string;
  outputPath: string;
  ffmpegPath: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
}

export interface FfmpegResult {
  success: boolean;
  durationSec?: number;
  error?: string;
}

/**
 * Run ffmpeg to download and remux a stream (HLS/DASH) to MP4.
 */
export async function runFfmpeg(options: FfmpegOptions): Promise<FfmpegResult> {
  const { inputUrl, outputPath, ffmpegPath, proxyConfig, timeoutMs = 300000 } = options;

  const args = [
    '-y',                    // overwrite output
    '-i', inputUrl,          // input URL
    '-c', 'copy',            // copy codecs (no re-encoding)
    '-movflags', '+faststart', // optimize for streaming
    outputPath,
  ];

  // Build minimal environment — don't leak secrets to subprocess
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  if (proxyConfig) {
    Object.assign(env, getFfmpegEnv(proxyConfig));
  }

  return new Promise<FfmpegResult>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let durationSec: number | undefined;

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new TimeoutError(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;

      // Parse duration from ffmpeg progress output
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (timeMatch) {
        const [, h, m, s] = timeMatch;
        durationSec = parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve({ success: true, durationSec });
      } else {
        reject(new FfmpegError(`ffmpeg exited with code ${code}`, 'FFMPEG_PROCESS_ERROR'));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new FfmpegError(`ffmpeg not found at: ${ffmpegPath}`, 'FFMPEG_NOT_FOUND'));
      } else {
        reject(new FfmpegError(err.message, 'FFMPEG_SPAWN_ERROR'));
      }
    });
  });
}

export interface FfmpegStreamOptions {
  inputUrl: string;
  ffmpegPath: string;
  args?: string[];
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
}

/**
 * Spawn ffmpeg with output piped to stdout. The caller is responsible for
 * piping proc.stdout to its destination (e.g., an HTTP response).
 *
 * Default args remux to fragmented MP4 (streamable, modifies file hash).
 * Pass custom `args` to override (e.g., for thumbnail extraction).
 */
export function spawnFfmpegStream(options: FfmpegStreamOptions): {
  proc: ChildProcess;
  stdout: Readable;
  kill: () => void;
} {
  const { inputUrl, ffmpegPath, proxyConfig, timeoutMs = 300000 } = options;

  const args = options.args ?? [
    '-y',
    '-i', inputUrl,
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    'pipe:1',
  ];

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  if (proxyConfig) {
    Object.assign(env, getFfmpegEnv(proxyConfig));
  }

  const proc = spawn(ffmpegPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
  }, timeoutMs);

  const cleanup = () => { clearTimeout(timer); };
  proc.on('close', cleanup);
  proc.on('error', cleanup);

  return {
    proc,
    stdout: proc.stdout as Readable,
    kill: () => { clearTimeout(timer); proc.kill('SIGKILL'); },
  };
}
