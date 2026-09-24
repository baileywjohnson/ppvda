import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { runFfmpeg } from '../../downloader/ffmpeg.js';
import { streamDownloadRequestSchema } from '../schemas/stream-download.js';
import { makeJobDir, secureRemoveDir } from '../../utils/fs.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { isBlockedHostLiteral, isPrivateUrl, pinnedLookup, safeResolveHost } from '../../utils/url.js';
import { isVpnSwitching } from '../../mullvad/index.js';
import { isDirectMediaUrl } from '../../extractor/patterns.js';
import { resolveProxy, type VpnPermissionStore } from '../vpn-permissions.js';
import { getHttpAgent } from '../../proxy/index.js';
import { clientGoneSignal, ffmpegRouteSem, streamDownloadUserLimit } from './ffmpeg-concurrency.js';
import { AbortedError, QueueFullError } from '../../utils/semaphore.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tiff']);

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff',
};

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot !== -1) return pathname.substring(dot).toLowerCase();
  } catch {}
  return '';
}

interface StreamDownloadBody {
  videoUrl: string;
  filename?: string;
  useVpn?: boolean;
}

export async function streamDownloadRoutes(
  app: FastifyInstance,
  opts: {
    proxyConfig?: ProxyConfig;
    vpnPermissions: VpnPermissionStore;
    ffmpegPath: string;
    downloadDir: string;
    downloadTimeoutMs: number;
    maxDownloadBytes: number;
    maxDownloadDurationSec: number;
    preHandler?: preHandlerHookHandler;
  },
) {
  app.post<{ Body: StreamDownloadBody }>(
    '/stream-download',
    {
      schema: { body: streamDownloadRequestSchema },
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { videoUrl, filename, useVpn } = request.body;
      const user = (request as any).user;
      // Created before any await so a hang-up at any point is seen.
      const signal = clientGoneSignal(reply);
      const proxy = resolveProxy(useVpn, user.sub, user.isAdmin, opts.vpnPermissions, opts.proxyConfig);

      if (proxy && isVpnSwitching()) {
        reply.status(503).send({ success: false, error: 'VPN is switching countries, try again in a moment' });
        return;
      }

      // Validate URL protocol and block private/internal targets
      try {
        const parsed = new URL(videoUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reply.status(400).send({ success: false, error: 'Only http/https URLs are supported' });
          return;
        }
      } catch {
        reply.status(400).send({ success: false, error: 'Invalid URL' });
        return;
      }

      if (await isPrivateUrl(videoUrl, { resolve: !proxy })) {
        reply.status(400).send({ success: false, error: 'Private/internal URLs are not allowed' });
        return;
      }

      // Per-user cap on running + queued downloads, so one account can't
      // fill the shared ffmpeg queue.
      const releaseUser = streamDownloadUserLimit.tryAcquire(user.sub);
      if (!releaseUser) {
        reply.status(429).send({ success: false, error: 'Too many downloads in progress — wait for one to finish' });
        return;
      }
      try {
        const ext = getExtFromUrl(videoUrl);
        const isImage = IMAGE_EXTENSIONS.has(ext);

        if (isImage) {
          await handleImageDownload(videoUrl, ext, filename, proxy, reply, opts.downloadTimeoutMs, opts.maxDownloadBytes, signal);
        } else {
          await handleVideoDownload(videoUrl, filename, proxy, reply, opts, signal);
        }
      } finally {
        releaseUser();
      }
    },
  );
}

// Headers for every hijacked response. hijack() bypasses the global onSend
// hook, so its nosniff/CSP never reach these; the body is attacker bytes
// served from the PPVDA origin and must never be interpreted as a document.
const DOWNLOAD_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'no-store',
} as const;

/**
 * Image download: direct HTTP fetch, no ffmpeg. Preserves original format.
 *
 * Uses Node's `http`/`https.request` with a pre-resolved-and-validated
 * `lookup` so the actual outbound connect uses the same address that
 * passed our SSRF check. Going through global `fetch` (undici) would let
 * its internal DNS resolution flip a public address to a private one
 * between the route-level `isPrivateUrl` check and the connect.
 */
async function handleImageDownload(
  url: string,
  ext: string,
  filename: string | undefined,
  proxy: ProxyConfig | undefined,
  reply: any,
  timeoutMs: number,
  maxBytes: number,
  signal: AbortSignal,
) {
  const safeName = sanitizeFilename(filename ?? 'image') + ext;
  const contentType = MIME_MAP[ext] ?? 'application/octet-stream';

  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    reply.status(400).send({ success: false, error: 'Invalid URL' });
    return;
  }

  const agent = proxy ? getHttpAgent(proxy) : undefined;
  let lookup: ReturnType<typeof pinnedLookup> | undefined;
  if (!agent) {
    const resolved = await safeResolveHost(parsed.hostname);
    if (!resolved) {
      reply.status(400).send({ success: false, error: 'Private/internal URLs are not allowed' });
      return;
    }
    lookup = pinnedLookup(resolved);
  } else if (isBlockedHostLiteral(parsed.hostname)) {
    reply.status(400).send({ success: false, error: 'Private/internal URLs are not allowed' });
    return;
  }
  const mod = parsed.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve) => {
    // One exit path: an error before the headers went out is a JSON error;
    // after the hijack the only honest signal is dropping the connection.
    let done = false;
    const finish = (status?: number, error?: string) => {
      if (done) return;
      done = true;
      if (status && !reply.raw.headersSent && !signal.aborted) {
        reply.status(status).send({ success: false, error });
      } else if (status) {
        reply.raw.destroy();
      }
      resolve();
    };

    const req = mod.request(
      url,
      {
        method: 'GET',
        agent,
        lookup,
        timeout: timeoutMs,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        // Redirects could point at a private host; refuse rather than
        // re-validate per hop.
        if (!res.statusCode || res.statusCode >= 400 || (res.statusCode >= 300 && res.statusCode < 400)) {
          res.resume();
          finish(502, 'Failed to download image');
          return;
        }

        const len = parseInt(String(res.headers['content-length'] ?? ''), 10);
        if (Number.isFinite(len) && len > maxBytes) {
          res.destroy();
          finish(413, 'Image too large');
          return;
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          ...DOWNLOAD_HEADERS,
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${safeName}"`,
          ...(Number.isFinite(len) && len >= 0 ? { 'Content-Length': String(len) } : {}),
        });

        // Byte cap for bodies without (or lying about) Content-Length.
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            finish(413, 'Image too large');
            return;
          }
          // Honour backpressure from a slow client.
          if (!reply.raw.write(chunk)) {
            res.pause();
            reply.raw.once('drain', () => res.resume());
          }
        });
        res.on('end', () => {
          reply.raw.end();
          finish();
        });
        res.on('close', () => {
          if (!res.complete) finish(502, 'Failed to download image');
        });
      },
    );
    req.on('error', () => finish(502, 'Failed to download image'));
    req.on('timeout', () => {
      req.destroy();
      finish(504, 'Image download timed out');
    });
    req.end();
  });
}

/**
 * Video download: via ffmpeg remux to MP4.
 */
async function handleVideoDownload(
  videoUrl: string,
  filename: string | undefined,
  proxy: ProxyConfig | undefined,
  reply: any,
  opts: { ffmpegPath: string; downloadDir: string; downloadTimeoutMs: number; maxDownloadBytes: number; maxDownloadDurationSec: number },
  signal: AbortSignal,
) {
  const safeName = sanitizeFilename(filename ?? 'video') + '.mp4';

  // Wait for an ffmpeg slot. A full queue is a 503; a client that hangs up
  // while queued is dropped from the queue rather than served later.
  try {
    await ffmpegRouteSem.acquire(signal);
  } catch (err) {
    if (err instanceof QueueFullError) {
      reply.status(503).send({ success: false, error: err.message });
    } else if (!(err instanceof AbortedError)) {
      throw err;
    }
    return;
  }
  // Stage inside DOWNLOAD_DIR (the tmpfs-backed location SECURITY.md
  // recommends), in a private per-request directory. This used to be
  // DOWNLOAD_DIR/../tmp, which sits outside that tmpfs.
  let workDir: string | undefined;
  try {
    workDir = await makeJobDir(opts.downloadDir);
    const tempPath = join(workDir, 'stream.mp4');
    // The signal kills ffmpeg if the client disconnects mid-download.
    await runFfmpeg({
      inputUrl: videoUrl,
      outputPath: tempPath,
      ffmpegPath: opts.ffmpegPath,
      proxyConfig: proxy,
      timeoutMs: opts.downloadTimeoutMs,
      maxBytes: opts.maxDownloadBytes,
      maxDurationSec: opts.maxDownloadDurationSec,
      signal,
    });

    const fileStat = await stat(tempPath);

    reply.hijack();
    reply.raw.writeHead(200, {
      ...DOWNLOAD_HEADERS,
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(fileStat.size),
    });

    try {
      await pipeline(createReadStream(tempPath), reply.raw);
    } catch {
      // Connection dropped mid-stream
    } finally {
      reply.raw.end();
    }
  } catch {
    // After hijack() Fastify no longer owns the response; only send an
    // error if headers haven't gone out yet.
    if (signal.aborted) {
      reply.raw.destroy();
    } else if (!reply.raw.headersSent) {
      reply.status(502).send({ success: false, error: 'Failed to download video' });
    } else {
      reply.raw.destroy();
    }
  } finally {
    if (workDir) await secureRemoveDir(workDir);
    ffmpegRouteSem.release();
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}
