import { createReadStream } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { runFfmpeg } from '../../downloader/ffmpeg.js';
import { streamDownloadRequestSchema } from '../schemas/stream-download.js';
import { generateId } from '../../utils/id.js';
import { ensureDir } from '../../utils/fs.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { isPrivateUrl } from '../../utils/url.js';
import { isVpnSwitching } from '../../mullvad/index.js';
import { isDirectMediaUrl } from '../../extractor/patterns.js';
import { getHttpAgent } from '../../proxy/index.js';

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
      const proxy = useVpn === false ? undefined : opts.proxyConfig;

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

  try {
    const fetchOpts: RequestInit & { dispatcher?: any } = {
      signal: AbortSignal.timeout(timeoutMs),
    };
    // Use proxy agent if configured
    if (proxy) {
      const agent = getHttpAgent(proxy);
      (fetchOpts as any).agent = agent;
    }

    const res = await fetch(url, fetchOpts);
    if (!res.ok || !res.body) {
      reply.status(502).send({ success: false, error: 'Failed to download image' });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      ...(res.headers.get('content-length') ? { 'Content-Length': res.headers.get('content-length') } : {}),
      'Cache-Control': 'no-store',
    });

    try {
      // @ts-ignore - Node fetch body is a ReadableStream
      for await (const chunk of res.body) {
        reply.raw.write(chunk);
      }
    } catch {
      // Client disconnected
    } finally {
      reply.raw.end();
    }
  } catch {
    reply.status(502).send({ success: false, error: 'Failed to download image' });
  }
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
      await unlink(tempPath).catch(() => {});
    }
  } catch {
    await unlink(tempPath).catch(() => {});
    reply.status(502).send({ success: false, error: 'Failed to download video' });
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}
