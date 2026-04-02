import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { runFfmpeg } from '../../downloader/ffmpeg.js';
import { streamDownloadRequestSchema } from '../schemas/stream-download.js';
import { generateId } from '../../utils/id.js';
import { ensureDir } from '../../utils/fs.js';
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
    downloadDir: string;
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

      // Download to a temp file with +faststart (produces a proper MP4)
      const tempDir = join(opts.downloadDir, '..', 'tmp');
      await ensureDir(tempDir);
      const tempPath = join(tempDir, `stream-${generateId()}.mp4`);

      try {
        await runFfmpeg({
          inputUrl: videoUrl,
          outputPath: tempPath,
          ffmpegPath: opts.ffmpegPath,
          proxyConfig: opts.proxyConfig,
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

        // Clean up if client disconnects early
        let aborted = false;
        request.raw.on('close', () => { aborted = true; });

        try {
          await pipeline(createReadStream(tempPath), reply.raw);
        } catch {
          // Connection dropped mid-stream
        } finally {
          reply.raw.end();
          // Delete temp file regardless of success
          await unlink(tempPath).catch(() => {});
        }
      } catch (err) {
        // ffmpeg failed — clean up and return error
        await unlink(tempPath).catch(() => {});
        reply.status(502).send({ success: false, error: 'Failed to download video' });
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
