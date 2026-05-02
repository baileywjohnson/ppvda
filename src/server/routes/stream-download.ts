import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { runFfmpeg } from '../../downloader/ffmpeg.js';
import { streamDownloadRequestSchema } from '../schemas/stream-download.js';
import { generateId } from '../../utils/id.js';
import { ensureDir, secureUnlink } from '../../utils/fs.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { isPrivateUrl, pinnedLookup, safeResolveHost } from '../../utils/url.js';
import { isVpnSwitching } from '../../mullvad/index.js';
import { isDirectMediaUrl } from '../../extractor/patterns.js';
import { resolveProxy, type VpnPermissionStore } from '../vpn-permissions.js';
import { getHttpAgent } from '../../proxy/index.js';
import { ffmpegRouteSem } from './ffmpeg-concurrency.js';

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

      if (await isPrivateUrl(videoUrl)) {
        reply.status(400).send({ success: false, error: 'Private/internal URLs are not allowed' });
        return;
      }

      const ext = getExtFromUrl(videoUrl);
      const isImage = IMAGE_EXTENSIONS.has(ext);

      if (isImage) {
        await handleImageDownload(videoUrl, ext, filename, proxy, request, reply, opts.downloadTimeoutMs);
      } else {
        await handleVideoDownload(videoUrl, filename, proxy, request, reply, opts);
      }
    },
  );
}

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
  request: any,
  reply: any,
  timeoutMs: number,
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
  }
  const mod = parsed.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent,
        lookup,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        // Redirects could point at a private host; refuse rather than
        // re-validate per hop.
        if (!res.statusCode || res.statusCode >= 400 || (res.statusCode >= 300 && res.statusCode < 400)) {
          res.resume();
          reply.status(502).send({ success: false, error: 'Failed to download image' });
          resolve();
          return;
        }

        const len = res.headers['content-length'];
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${safeName}"`,
          ...(len ? { 'Content-Length': String(len) } : {}),
          'Cache-Control': 'no-store',
        });

        res.on('data', (chunk: Buffer) => {
          reply.raw.write(chunk);
        });
        res.on('end', () => {
          reply.raw.end();
          resolve();
        });
        res.on('error', () => {
          reply.raw.end();
          resolve();
        });
      },
    );
    req.on('error', () => {
      reply.status(502).send({ success: false, error: 'Failed to download image' });
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      reply.status(504).send({ success: false, error: 'Image download timed out' });
      resolve();
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
  request: any,
  reply: any,
  opts: { ffmpegPath: string; downloadDir: string; downloadTimeoutMs: number },
) {
  const safeName = sanitizeFilename(filename ?? 'video') + '.mp4';

  const tempDir = join(opts.downloadDir, '..', 'tmp');
  await ensureDir(tempDir);
  const tempPath = join(tempDir, `stream-${generateId()}.mp4`);

  await ffmpegRouteSem.acquire();
  try {
    await runFfmpeg({
      inputUrl: videoUrl,
      outputPath: tempPath,
      ffmpegPath: opts.ffmpegPath,
      proxyConfig: proxy,
      timeoutMs: opts.downloadTimeoutMs,
    });

    const fileStat = await stat(tempPath);

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-store',
    });

    let aborted = false;
    request.raw.on('close', () => { aborted = true; });

    try {
      await pipeline(createReadStream(tempPath), reply.raw);
    } catch {
      // Connection dropped mid-stream
    } finally {
      reply.raw.end();
      await secureUnlink(tempPath);
    }
  } catch {
    await secureUnlink(tempPath);
    reply.status(502).send({ success: false, error: 'Failed to download video' });
  } finally {
    ffmpegRouteSem.release();
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}
