import { spawn, type ChildProcess } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { FfmpegError, TimeoutError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
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
// choke-point in front of its HTTP egress: a loopback-only HTTP proxy that
// every CONNECT target and absolute-URI request has to pass before the
// tunnel opens, so ffmpeg cannot reach a private IP even via manifest
// redirects or DNS rebinding between our validation and its connect.
//
// This applies with a PROXY_URL too — the SsrfProxy chains to it. ffmpeg
// only honours `http_proxy` values starting with http://, so handing it a
// socks5:// or https:// proxy URL (as this used to) made it ignore the
// proxy entirely and connect from the host's real IP, unfiltered.
export async function setupSubprocessEnv(proxyConfig?: ProxyConfig): Promise<{
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const env = minimalEnv();
  const proxy = new SsrfProxy(proxyConfig);
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

/**
 * Environment for ffmpeg/ffprobe children: just enough to run. Never the
 * full process.env, which carries JWT_SECRET, MULLVAD_ACCOUNT and the admin
 * bootstrap password into a process that parses attacker-supplied media.
 */
export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR'] as const) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env;
}

// Demuxers allowed for local files we downloaded (attacker-controlled
// bytes). Every one of them reads only the single input it is given.
// Deliberately absent: hls, dash, concat, image2 (sequence/glob patterns),
// and every other demuxer that can open further inputs. Letting ffmpeg
// content-probe would pick those for a playlist saved as `video.mp4` and
// have it read neighbouring files, or fetch URLs with no SSRF proxy in the
// path. Forcing the format means the probe never runs.
const LOCAL_DEMUXERS = new Set([
  'mov', 'matroska', 'avi', 'flv', 'asf', 'mpegts',
  'jpeg_pipe', 'png_pipe', 'gif', 'webp_pipe', 'bmp_pipe',
]);

/**
 * Identify a local media file's container from its magic bytes and return
 * the ffmpeg demuxer to force, or null if it isn't one we accept.
 */
export async function sniffLocalDemuxer(filePath: string): Promise<string | null> {
  const head = Buffer.alloc(512);
  let n: number;
  try {
    const fh = await open(filePath, 'r');
    try {
      ({ bytesRead: n } = await fh.read(head, 0, head.length, 0));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const b = head.subarray(0, n);
  const ascii = (start: number, end: number) => b.subarray(start, end).toString('latin1');
  if (n < 12) return null;

  // ISO-BMFF / QuickTime (mp4, mov, m4v, avif): a top-level box type at 4..8.
  if (['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(ascii(4, 8))) return 'mov';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska'; // mkv, webm
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return 'avi';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp_pipe';
  if (ascii(0, 3) === 'FLV') return 'flv';
  if (b.subarray(0, 8).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]))) return 'asf';
  if (b[0] === 0x47 && n > 188 && b[188] === 0x47) return 'mpegts';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg_pipe';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png_pipe';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 2) === 'BM') return 'bmp_pipe';
  return null;
}

/**
 * ffmpeg/ffprobe input arguments for a local file we downloaded: file
 * protocol only, a forced demuxer from the allow-list above, and QuickTime
 * external data references off. Returns null when the file isn't a
 * container we accept — callers treat that like any other ffmpeg failure.
 */
export async function localInputArgs(filePath: string): Promise<string[] | null> {
  const demuxer = await sniffLocalDemuxer(filePath);
  if (!demuxer || !LOCAL_DEMUXERS.has(demuxer)) return null;
  return [
    '-protocol_whitelist', 'file',
    '-format_whitelist', demuxer,
    '-f', demuxer,
    ...(demuxer === 'mov' ? ['-enable_drefs', '0'] : []),
    '-i', filePath,
  ];
}

export interface FfmpegOptions {
  inputUrl: string;
  outputPath: string;
  ffmpegPath: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
  /** Output size cap (ffmpeg `-fs`). Hitting it fails the download. */
  maxBytes?: number;
  /** Output duration cap in seconds (ffmpeg `-t`). Longer inputs fail. */
  maxDurationSec?: number;
  /** Kills ffmpeg when aborted (e.g. the requesting client disconnected). */
  signal?: AbortSignal;
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
  const input = await localInputArgs(inputPath);
  if (!input) return { success: false };
  const args = [
    '-nostdin',
    '-y',
    ...input,
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    // Explicit: the output name has no media extension for ffmpeg to go by.
    '-f', 'mp4',
    outputPath,
  ];
  return new Promise<{ success: boolean }>((resolve) => {
    const proc = spawn(ffmpegPath, args, { env: minimalEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
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

// How much of ffmpeg's stderr to buffer: the head, which holds the input
// banner (container + duration). Progress lines are parsed per chunk and
// never accumulated, so a multi-hour download can't grow this.
const STDERR_HEAD_BYTES = 16 * 1024;

/**
 * Run ffmpeg to download and remux a stream (HLS/DASH) to MP4.
 *
 * Bounded three ways: wall clock (timeoutMs), output bytes (`-fs`) and
 * output duration (`-t`). ffmpeg treats `-fs`/`-t` as "stop here" and exits
 * 0 with a truncated file, so reaching either cap is turned into a failure
 * here rather than handed on as a complete download. A live HLS/DASH input
 * (no total duration — it would grow until a cap trips) is refused as soon
 * as ffmpeg prints its input banner.
 */
export async function runFfmpeg(options: FfmpegOptions): Promise<FfmpegResult> {
  const { inputUrl, outputPath, ffmpegPath, proxyConfig, timeoutMs = 300000, maxBytes, maxDurationSec, signal } = options;

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
  if (signal?.aborted) throw new FfmpegError('ffmpeg cancelled', 'ABORTED');

  const args = [
    '-nostdin',
    '-y',                    // overwrite output
    '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '-i', inputUrl,          // input URL
    '-c', 'copy',            // copy codecs (no re-encoding)
    // Fragmented MP4 — required for MSE playback in the Darkreel SPA viewer.
    // Matches the flags darkreel-cli and the in-browser mp4box remux produce.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    ...(maxBytes !== undefined ? ['-fs', String(maxBytes)] : []),
    ...(maxDurationSec !== undefined ? ['-t', String(maxDurationSec)] : []),
    outputPath,
  ];

  const { env, cleanup } = await setupSubprocessEnv(proxyConfig);

  return new Promise<FfmpegResult>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let head = '';
    let bannerChecked = false;
    let durationSec: number | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      cleanup().finally(fn);
    };
    const fail = (err: Error) => {
      proc.kill('SIGKILL');
      settle(() => reject(err));
    };

    const timeout = setTimeout(() => {
      fail(new TimeoutError(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => fail(new FfmpegError('ffmpeg cancelled', 'ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();

      if (!bannerChecked) {
        head = (head + text).slice(0, STDERR_HEAD_BYTES);
        const banner = /Input #0, ([\w,]+), from[\s\S]*?Duration: (N\/A|(\d+):(\d{2}):(\d{2}))/.exec(head);
        if (banner) {
          bannerChecked = true;
          const format = banner[1];
          if (banner[2] === 'N/A') {
            if (format === 'hls' || format === 'dash') {
              fail(new FfmpegError('Live streams are not supported', 'LIVE_STREAM'));
              return;
            }
          } else if (maxDurationSec !== undefined) {
            const inputSec = parseInt(banner[3], 10) * 3600 + parseInt(banner[4], 10) * 60 + parseInt(banner[5], 10);
            if (inputSec > maxDurationSec) {
              fail(new FfmpegError('Stream exceeds the maximum duration', 'DURATION_EXCEEDED'));
              return;
            }
          }
        } else if (head.length >= STDERR_HEAD_BYTES) {
          bannerChecked = true;
        }
      }

      // Parse duration from ffmpeg progress output
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (timeMatch) {
        const [, h, m, s] = timeMatch;
        durationSec = parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        settle(() => reject(new FfmpegError(`ffmpeg exited with code ${code}`, 'FFMPEG_PROCESS_ERROR')));
        return;
      }
      // Exit 0 also covers "stopped at -fs/-t". Treat reaching either cap as
      // a truncated, failed download.
      stat(outputPath).then((st) => {
        if (maxBytes !== undefined && st.size >= maxBytes) {
          settle(() => reject(new FfmpegError('Stream exceeds the maximum download size', 'SIZE_EXCEEDED')));
        } else if (maxDurationSec !== undefined && durationSec !== undefined && durationSec >= maxDurationSec) {
          settle(() => reject(new FfmpegError('Stream exceeds the maximum duration', 'DURATION_EXCEEDED')));
        } else {
          settle(() => resolve({ success: true, durationSec }));
        }
      }, () => {
        settle(() => reject(new FfmpegError('ffmpeg produced no output', 'FFMPEG_PROCESS_ERROR')));
      });
    });

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        settle(() => reject(new FfmpegError('ffmpeg not found', 'FFMPEG_NOT_FOUND')));
      } else {
        settle(() => reject(new FfmpegError('ffmpeg could not be started', 'FFMPEG_SPAWN_ERROR')));
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
  /** Kills ffmpeg when aborted (e.g. the requesting client disconnected). */
  signal?: AbortSignal;
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
  const { inputUrl, ffmpegPath, proxyConfig, timeoutMs = 300000, signal } = options;

  // Block non-HTTP protocols to prevent file://, gopher://, concat: etc.
  const protocol = (() => { try { return new URL(inputUrl).protocol; } catch { return ''; } })();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new FfmpegError('Only http/https URLs are supported by ffmpeg', 'INVALID_PROTOCOL');
  }

  // Always include protocol whitelist, even with custom args
  const baseArgs = ['-nostdin', '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST];
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

  // stderr is discarded rather than piped: nothing reads it, and a full
  // pipe buffer would stall ffmpeg until the timeout.
  const proc = spawn(ffmpegPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
  }, timeoutMs);
  const onAbort = () => proc.kill('SIGKILL');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  let stopped = false;
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
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
