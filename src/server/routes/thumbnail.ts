import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { spawnFfmpegStream } from '../../downloader/ffmpeg.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { isPrivateUrl } from '../../utils/url.js';
import { getHttpAgent } from '../../proxy/index.js';
import { ffmpegRouteSem } from './ffmpeg-concurrency.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tiff']);

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

      if (IMAGE_EXTENSIONS.has(ext)) {
        await handleImageProxy(videoUrl, opts.proxyConfig, request, reply);
      } else {
        await handleVideoThumbnail(videoUrl, t ?? '2', opts, request, reply);
      }
    },
  );
}

/**
 * For images: fetch and proxy directly. Preserves original format.
 */
async function handleImageProxy(
  url: string,
  proxy: ProxyConfig | undefined,
  request: any,
  reply: any,
) {
  try {
    const fetchOpts: RequestInit = {
      signal: AbortSignal.timeout(10000),
    };
    if (proxy) {
      (fetchOpts as any).agent = getHttpAgent(proxy);
    }

    const res = await fetch(url, fetchOpts);
    if (!res.ok || !res.body) {
      reply.status(404).send({ success: false, error: 'Could not fetch image' });
      return;
    }

    // Reject oversized responses to prevent OOM (10 MB limit)
    const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
    if (contentLength > 10 * 1024 * 1024) {
      reply.status(413).send({ success: false, error: 'Image too large' });
      return;
    }

    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const maxBytes = 10 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    // @ts-ignore
    for await (const chunk of res.body) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reply.status(413).send({ success: false, error: 'Image too large' });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);

    reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'private, max-age=300')
      .send(data);
  } catch {
    reply.status(404).send({ success: false, error: 'Could not fetch image' });
  }
}

/**
 * For videos: use ffmpeg to extract a single frame as JPEG.
 */
async function handleVideoThumbnail(
  videoUrl: string,
  seekTime: string,
  opts: { proxyConfig?: ProxyConfig; ffmpegPath: string },
  request: any,
  reply: any,
) {
  // Validate seekTime is a non-negative number to prevent unexpected ffmpeg behavior
  if (!/^\d+(\.\d+)?$/.test(seekTime)) {
    reply.status(400).send({ success: false, error: 'Invalid seek time — must be a non-negative number' });
    return;
  }

  await ffmpegRouteSem.acquire();
  try {
    const { proc, stdout, kill } = spawnFfmpegStream({
      inputUrl: videoUrl,
      ffmpegPath: opts.ffmpegPath,
      proxyConfig: opts.proxyConfig,
      timeoutMs: 15000,
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
    let aborted = false;

    stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_THUMBNAIL_BYTES) {
        if (!aborted) {
          aborted = true;
          kill();
        }
        return;
      }
      chunks.push(chunk);
    });

    const result = await new Promise<Buffer | null>((resolve) => {
      proc.on('close', (code) => {
        if (!aborted && code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(null);
        }
      });
      proc.on('error', () => resolve(null));
    });

    request.raw.on('close', () => kill());

    if (result) {
      reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, max-age=300')
        .send(result);
    } else {
      reply.status(404).send({ success: false, error: 'Could not generate thumbnail' });
    }
  } finally {
    ffmpegRouteSem.release();
  }
}
