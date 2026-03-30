import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { spawnFfmpegStream } from '../../downloader/ffmpeg.js';
import { streamDownloadRequestSchema } from '../schemas/stream-download.js';
import type { ProxyConfig } from '../../proxy/types.js';

interface StreamDownloadBody {
  videoUrl: string;
  filename?: string;
}

export async function streamDownloadRoutes(
  app: FastifyInstance,
  opts: {
    proxyConfig?: ProxyConfig;
    ffmpegPath: string;
    downloadTimeoutMs: number;
    preHandler?: preHandlerHookHandler;
  },
) {
  app.post<{ Body: StreamDownloadBody }>(
    '/stream-download',
    {
      schema: { body: streamDownloadRequestSchema },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { videoUrl, filename } = request.body;

      // Validate URL protocol to prevent SSRF
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

      const safeName = sanitizeFilename(filename ?? 'video') + '.mp4';

      const { proc, stdout, kill } = spawnFfmpegStream({
        inputUrl: videoUrl,
        ffmpegPath: opts.ffmpegPath,
        proxyConfig: opts.proxyConfig,
        timeoutMs: opts.downloadTimeoutMs,
      });

      // Take over the response immediately
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Cache-Control': 'no-store',
        'Transfer-Encoding': 'chunked',
      });

      // Clean up if client disconnects
      request.raw.on('close', () => {
        kill();
      });

      // Log ffmpeg errors (don't accumulate the full stderr — just last line for debugging)
      let lastStderrLine = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().trim().split('\n');
        lastStderrLine = lines[lines.length - 1] || lastStderrLine;
      });

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          request.log.warn({ code }, 'ffmpeg stream exited with error');
        }
      });

      try {
        await pipeline(stdout, reply.raw);
      } catch {
        // Connection dropped or ffmpeg error mid-stream
      } finally {
        reply.raw.end();
      }
    },
  );
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}
