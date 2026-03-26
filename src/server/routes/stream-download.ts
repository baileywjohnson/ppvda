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

      // Collect stderr for error detection
      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Wait briefly for ffmpeg to start and potentially fail fast
      const startError = await new Promise<string | null>((resolve) => {
        const earlyFail = (code: number | null) => {
          resolve(stderr || `ffmpeg exited with code ${code}`);
        };
        proc.once('close', earlyFail);

        // Give ffmpeg 2s to fail or start producing output
        const timer = setTimeout(() => {
          proc.removeListener('close', earlyFail);
          resolve(null);
        }, 2000);

        stdout.once('data', () => {
          clearTimeout(timer);
          proc.removeListener('close', earlyFail);
          resolve(null);
        });
      });

      if (startError) {
        kill();
        reply.status(502).send({ success: false, error: 'Failed to process video' });
        return;
      }

      // Take over the response
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Cache-Control': 'no-store',
      });

      // Clean up if client disconnects
      request.raw.on('close', () => {
        kill();
      });

      try {
        await pipeline(stdout, reply.raw);
      } catch {
        // Connection dropped or ffmpeg error mid-stream — nothing to do
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
