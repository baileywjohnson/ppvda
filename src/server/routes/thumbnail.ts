import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { spawnFfmpegStream } from '../../downloader/ffmpeg.js';
import type { ProxyConfig } from '../../proxy/types.js';

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
      const seekTime = t ?? '2';

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

      // Collect JPEG data (single frame, small)
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

      const result = await new Promise<Buffer | null>((resolve) => {
        proc.on('close', (code) => {
          if (code === 0 && chunks.length > 0) {
            resolve(Buffer.concat(chunks));
          } else {
            resolve(null);
          }
        });
        proc.on('error', () => resolve(null));
      });

      // Clean up on client disconnect
      request.raw.on('close', () => kill());

      if (result) {
        reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'private, max-age=300')
          .send(result);
      } else {
        reply.status(404).send({ success: false, error: 'Could not generate thumbnail' });
      }
    },
  );
}
