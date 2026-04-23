import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { FfmpegError, TimeoutError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getFfmpegEnv } from '../proxy/index.js';
import { SsrfProxy } from '../utils/ssrf-proxy.js';

// Protocol whitelist for ffmpeg/ffprobe URL inputs. `file` is intentionally
// absent — no legitimate extraction or download path needs local-file URIs,
// and allowing it turned every `-i` into a potential path-disclosure or
// server-side file-read primitive if the URL ever got user-influenced.
// `crypto` is required for HLS AES-128 decryption; `tcp`/`tls` sit under
// `http`/`https`. `httpproxy` is required when http_proxy/https_proxy env
// vars are set — ffmpeg uses that internal protocol to speak to the proxy,
// and if it's missing from the whitelist the input silently fails with
// "Protocol 'httpproxy' not on whitelist" and no bytes are produced.
export const FFMPEG_PROTOCOL_WHITELIST = 'http,https,httpproxy,tcp,tls,crypto';

// Set up a subprocess environment for ffmpeg/ffprobe with an SSRF-filtering
// choke-point in front of its HTTP egress. When the operator has configured
// an explicit `proxyConfig` (SOCKS or HTTP proxy via PROXY_URL) we trust it
// and skip the SSRF proxy — they've consciously opted into that network
// path. Otherwise, we start a loopback-only HTTP proxy that every CONNECT
// target and absolute-URI request has to pass `safeResolveHost` before the
// tunnel opens, so ffmpeg cannot reach a private IP even via manifest
// redirects or DNS rebinding between our validation and its connect.
export async function setupSubprocessEnv(proxyConfig?: ProxyConfig): Promise<{
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  if (proxyConfig) {
    Object.assign(env, getFfmpegEnv(proxyConfig));
    return { env, cleanup: async () => {} };
  }
  const proxy = new SsrfProxy();
  await proxy.start();
  const url = proxy.url();
  // Both lowercase (ffmpeg/libcurl convention) and uppercase — different
  // builds look at different casings.
  env.http_proxy = url;
  env.https_proxy = url;
  env.HTTP_PROXY = url;
  env.HTTPS_PROXY = url;
  return { env, cleanup: () => proxy.stop() };
}

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
 * Remux a local MP4/MOV/etc. to fragmented MP4 (moof/mdat segments with an
 * empty-moov init). Required when the source is a plain direct download —
 * non-fragmented files have no moof boxes, so Darkreel's segment scanner
 * treats them as a single whole-file chunk, which MSE cannot stream.
 *
 * Uses `-c copy` so there's no re-encode — just container rewrite. Returns
 * { success: false } without throwing so callers can fall back to uploading
 * the original as non-fragmented.
 */
export async function remuxToFragmentedMP4(options: {
  inputPath: string;
  outputPath: string;
  ffmpegPath: string;
  timeoutMs?: number;
}): Promise<{ success: boolean }> {
  const { inputPath, outputPath, ffmpegPath, timeoutMs = 120000 } = options;
  const args = [
    '-y',
    '-i', inputPath,
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    outputPath,
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
  };
  return new Promise<{ success: boolean }>((resolve) => {
    const proc = spawn(ffmpegPath, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ success: false });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0 });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ success: false });
    });
  });
}

/**
 * Run ffmpeg to download and remux a stream (HLS/DASH) to MP4.
 */
export async function runFfmpeg(options: FfmpegOptions): Promise<FfmpegResult> {
  const { inputUrl, outputPath, ffmpegPath, proxyConfig, timeoutMs = 300000 } = options;

  // Block non-HTTP protocols to prevent file://, gopher://, concat: etc.
  try {
    const protocol = new URL(inputUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new FfmpegError('Only http/https URLs are supported by ffmpeg', 'INVALID_PROTOCOL');
    }
  } catch (err) {
    if (err instanceof FfmpegError) throw err;
    throw new FfmpegError('Invalid input URL', 'INVALID_URL');
  }

  const args = [
    '-y',                    // overwrite output
    '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '-i', inputUrl,          // input URL
    '-c', 'copy',            // copy codecs (no re-encoding)
    // Fragmented MP4 — required for MSE playback in the Darkreel SPA viewer.
    // Matches the flags darkreel-cli and the in-browser mp4box remux produce.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    outputPath,
  ];

  const { env, cleanup } = await setupSubprocessEnv(proxyConfig);

  return new Promise<FfmpegResult>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let durationSec: number | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup().finally(fn);
    };

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(() => reject(new TimeoutError(`ffmpeg timed out after ${timeoutMs}ms`)));
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
        settle(() => resolve({ success: true, durationSec }));
      } else {
        settle(() => reject(new FfmpegError(`ffmpeg exited with code ${code}`, 'FFMPEG_PROCESS_ERROR')));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        settle(() => reject(new FfmpegError(`ffmpeg not found at: ${ffmpegPath}`, 'FFMPEG_NOT_FOUND')));
      } else {
        settle(() => reject(new FfmpegError(err.message, 'FFMPEG_SPAWN_ERROR')));
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
export async function spawnFfmpegStream(options: FfmpegStreamOptions): Promise<{
  proc: ChildProcess;
  stdout: Readable;
  kill: () => void;
}> {
  const { inputUrl, ffmpegPath, proxyConfig, timeoutMs = 300000 } = options;

  // Block non-HTTP protocols to prevent file://, gopher://, concat: etc.
  const protocol = (() => { try { return new URL(inputUrl).protocol; } catch { return ''; } })();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new FfmpegError('Only http/https URLs are supported by ffmpeg', 'INVALID_PROTOCOL');
  }

  // Always include protocol whitelist, even with custom args
  const baseArgs = ['-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST];
  const args = options.args
    ? [...baseArgs, ...options.args]
    : [
      '-y',
      ...baseArgs,
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '-i', inputUrl,
      '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      'pipe:1',
    ];

  const { env, cleanup: stopProxy } = await setupSubprocessEnv(proxyConfig);

  const proc = spawn(ffmpegPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
  }, timeoutMs);

  let stopped = false;
  const cleanup = () => {
    clearTimeout(timer);
    if (!stopped) {
      stopped = true;
      // Fire-and-forget — the caller has already moved on by now, we just
      // don't want to keep the proxy listener alive past ffmpeg exit.
      stopProxy().catch(() => { /* best effort */ });
    }
  };
  proc.on('close', cleanup);
  proc.on('error', cleanup);

  return {
    proc,
    stdout: proc.stdout as Readable,
    kill: () => { cleanup(); proc.kill('SIGKILL'); },
  };
}
