import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import http from 'node:http';
import https from 'node:https';
import { spawnFfmpegStream } from '../../downloader/ffmpeg.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { isBlockedHostLiteral, isPrivateUrl, pinnedLookup, safeResolveHost } from '../../utils/url.js';
import { getHttpAgent } from '../../proxy/index.js';
import { clientGoneSignal, ffmpegRouteSem, thumbnailUserLimit } from './ffmpeg-concurrency.js';
import { AbortedError, QueueFullError } from '../../utils/semaphore.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tiff']);

// Content types the image proxy may pass through. Raster formats only: SVG
// is a scriptable document, and anything else (text/html, JS, …) served
// from the PPVDA origin would be same-origin script/markup — e.g. a
// `<script src="/thumbnail?videoUrl=…">` that satisfies `script-src 'self'`.
const SAFE_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
]);

/** Map an upstream Content-Type to one we are willing to serve. */
function safeImageContentType(upstream: string | undefined): string {
  const essence = (upstream ?? '').split(';')[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(essence) ? essence : 'application/octet-stream';
}

// Sent with every thumbnail body, whatever its type. The CSP here replaces
// the app-wide one (see server/index.ts): even if a browser were talked
// into rendering the bytes as a document, it gets an opaque origin and no
// script.
const THUMBNAIL_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'inline; filename="thumb"',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, max-age=300',
} as const;

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot !== -1) return pathname.substring(dot).toLowerCase();
  } catch {}
  return '';
}

export async function thumbnailRoutes(
  app: FastifyInstance,
  opts: {
    proxyConfig?: ProxyConfig;
    ffmpegPath: string;
    preHandler?: preHandlerHookHandler;
  },
) {
  app.get<{ Querystring: { videoUrl: string; t?: string } }>(
    '/thumbnail',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['videoUrl'],
          properties: {
            videoUrl: { type: 'string', minLength: 1 },
            t: { type: 'string' },
          },
        },
      },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { videoUrl, t } = request.query;
      // Created before any await so a hang-up at any point is seen.
      const signal = clientGoneSignal(reply);

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

      if (await isPrivateUrl(videoUrl, { resolve: !opts.proxyConfig })) {
        reply.status(400).send({ success: false, error: 'Private/internal URLs are not allowed' });
        return;
      }

      // Per-user cap on running + queued thumbnails; the ffmpeg queue
      // behind it is shared by every user.
      const releaseUser = thumbnailUserLimit.tryAcquire((request as any).user.sub);
      if (!releaseUser) {
        reply.status(429).send({ success: false, error: 'Too many thumbnail requests in progress' });
        return;
      }
      try {
        const ext = getExtFromUrl(videoUrl);

        if (IMAGE_EXTENSIONS.has(ext)) {
          await handleImageProxy(videoUrl, opts.proxyConfig, reply, signal);
        } else {
          await handleVideoThumbnail(videoUrl, t ?? '2', opts, reply, signal);
        }
      } finally {
        releaseUser();
      }
    },
  );
}

/**
 * For images: fetch and proxy directly. Preserves original format.
 *
 * Uses Node's `http`/`https.request` rather than global `fetch` so we can
 * supply a `lookup` function that returns a pre-validated address. This
 * closes the DNS-rebinding window between the route-level `isPrivateUrl`
 * check and the actual outbound connection — `fetch` (undici) does its
 * own internal DNS resolution that can flip a public IP back to a
 * private one between the two events.
 */
async function handleImageProxy(
  url: string,
  proxy: ProxyConfig | undefined,
  reply: any,
  signal: AbortSignal,
) {
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

  const MAX_BYTES = 10 * 1024 * 1024;

  await new Promise<void>((resolve) => {
    const req = mod.request(url, { method: 'GET', agent, lookup, timeout: 10000, signal }, (res) => {
      // Block redirects: an attacker could redirect to a private host that
      // the next DNS resolution might or might not catch. Easier to refuse.
      if (!res.statusCode || res.statusCode >= 400 || (res.statusCode >= 300 && res.statusCode < 400)) {
        res.resume();
        reply.status(404).send({ success: false, error: 'Could not fetch image' });
        resolve();
        return;
      }

      const contentLength = parseInt(String(res.headers['content-length'] ?? '0'), 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
        res.resume();
        reply.status(413).send({ success: false, error: 'Image too large' });
        resolve();
        return;
      }

      const contentType = safeImageContentType(res.headers['content-type']);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let oversized = false;
      res.on('data', (chunk: Buffer) => {
        if (oversized) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          oversized = true;
          res.destroy();
          reply.status(413).send({ success: false, error: 'Image too large' });
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (oversized) return;
        reply
          .headers(THUMBNAIL_HEADERS)
          .header('Content-Type', contentType)
          .send(Buffer.concat(chunks));
        resolve();
      });
      res.on('error', () => {
        if (oversized) return;
        reply.status(404).send({ success: false, error: 'Could not fetch image' });
        resolve();
      });
    });
    req.on('error', () => {
      reply.status(404).send({ success: false, error: 'Could not fetch image' });
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      reply.status(504).send({ success: false, error: 'Image fetch timed out' });
      resolve();
    });
    req.end();
  });
}

/**
 * For videos: use ffmpeg to extract a single frame as JPEG.
 */
async function handleVideoThumbnail(
  videoUrl: string,
  seekTime: string,
  opts: { proxyConfig?: ProxyConfig; ffmpegPath: string },
  reply: any,
  signal: AbortSignal,
) {
  // Validate seekTime is a non-negative number to prevent unexpected ffmpeg behavior
  if (!/^\d+(\.\d+)?$/.test(seekTime)) {
    reply.status(400).send({ success: false, error: 'Invalid seek time — must be a non-negative number' });
    return;
  }

  // A full queue is a 503; a client that hangs up while queued is dropped
  // from the queue instead of getting an ffmpeg run nobody will receive.
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
  try {
    // The signal kills ffmpeg (and stops its SSRF proxy) if the client
    // disconnects mid-generation, freeing the slot immediately.
    const { proc, stdout, kill } = await spawnFfmpegStream({
      inputUrl: videoUrl,
      ffmpegPath: opts.ffmpegPath,
      proxyConfig: opts.proxyConfig,
      timeoutMs: 15000,
      signal,
      args: [
        '-y',
        '-i', videoUrl,
        '-ss', seekTime,
        '-frames:v', '1',
        '-vf', 'scale=320:-1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ],
    });

    const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024; // 5 MB — a single JPEG frame is ~50-200 KB
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let oversized = false;

    stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_THUMBNAIL_BYTES) {
        if (!oversized) {
          oversized = true;
          kill();
        }
        return;
      }
      chunks.push(chunk);
    });

    const result = await new Promise<Buffer | null>((resolve) => {
      proc.on('close', (code) => {
        if (!oversized && code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(null);
        }
      });
      proc.on('error', () => resolve(null));
    });

    if (signal.aborted) return;
    if (result) {
      reply
        .headers(THUMBNAIL_HEADERS)
        .header('Content-Type', 'image/jpeg')
        .send(result);
    } else {
      reply.status(404).send({ success: false, error: 'Could not generate thumbnail' });
    }
  } finally {
    ffmpegRouteSem.release();
  }
}
