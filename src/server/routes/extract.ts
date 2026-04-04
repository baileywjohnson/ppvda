import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { extractVideos, extractVideosStreaming } from '../../extractor/index.js';
import { extractRequestSchema, extractResponseSchema } from '../schemas/extract.js';
import { probeVideo, qualityFromResolution } from '../../downloader/probe.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { isPrivateUrl } from '../../utils/url.js';
import { isVpnSwitching } from '../../mullvad/index.js';
import { resolveProxy, type VpnPermissionStore } from '../vpn-permissions.js';

interface ExtractBody {
  url: string;
  timeout?: number;
  useVpn?: boolean;
  includeImages?: boolean;
  autoPlay?: boolean;
}

export async function extractRoutes(
  app: FastifyInstance,
  opts: { proxyConfig?: ProxyConfig; vpnPermissions: VpnPermissionStore; ffmpegPath: string; defaultTimeoutMs: number; defaultNetworkIdleMs: number; preferredHosts: string[]; blockedHosts: string[]; allowedHosts: string[]; preHandler?: preHandlerHookHandler },
) {
  app.post<{ Body: ExtractBody }>(
    '/extract',
    {
      schema: {
        body: extractRequestSchema,
        response: { 200: extractResponseSchema },
      },
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { url, timeout, useVpn, includeImages, autoPlay } = request.body;
      const user = (request as any).user;
      const proxy = resolveProxy(useVpn, user.sub, user.isAdmin, opts.vpnPermissions, opts.proxyConfig);

      if (proxy && isVpnSwitching()) {
        reply.status(503).send({ success: false, error: 'VPN is switching countries, try again in a moment' });
        return;
      }

      if (await isPrivateUrl(url)) {
        reply.status(400).send({ success: false, error: 'Private/internal URLs are not allowed' });
        return;
      }

      const result = await extractVideos({
        url,
        timeoutMs: timeout ?? opts.defaultTimeoutMs,
        networkIdleMs: opts.defaultNetworkIdleMs,
        proxy,
        preferredHosts: opts.preferredHosts,
        blockedHosts: opts.blockedHosts,
        allowedHosts: opts.allowedHosts,
        includeImages,
        autoPlay,
      });

      return { success: true, data: result };
    },
  );

  // Streaming extraction — SSE endpoint that emits videos as they're discovered
  app.post<{ Body: ExtractBody }>(
    '/extract/stream',
    {
      schema: { body: extractRequestSchema },
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { url, timeout, useVpn, includeImages, autoPlay } = request.body;
      const user = (request as any).user;
      const proxy = resolveProxy(useVpn, user.sub, user.isAdmin, opts.vpnPermissions, opts.proxyConfig);

      if (proxy && isVpnSwitching()) {
        reply.status(503).send({ success: false, error: 'VPN is switching countries, try again in a moment' });
        return;
      }

      if (await isPrivateUrl(url)) {
        reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ success: false, error: 'Private/internal URLs are not allowed' }));
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let closed = false;
      request.raw.on('close', () => { closed = true; });

      function write(event: string, data: Record<string, unknown>) {
        if (closed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      // Track background probe promises so we wait for them before closing
      const probePromises: Promise<void>[] = [];
      let videoIndex = 0;

      await extractVideosStreaming({
        url,
        timeoutMs: timeout ?? opts.defaultTimeoutMs,
        networkIdleMs: opts.defaultNetworkIdleMs,
        proxy,
        preferredHosts: opts.preferredHosts,
        blockedHosts: opts.blockedHosts,
        allowedHosts: opts.allowedHosts,
        includeImages,
        autoPlay,
        onVideo: (video) => {
          const idx = videoIndex++;
          write('video', { ...video, _idx: idx });

          // Fire off ffprobe in the background
          const probeP = probeVideo({
            url: video.url,
            ffprobePath: opts.ffmpegPath.replace(/ffmpeg$/, 'ffprobe'),
            proxyConfig: proxy,
            timeoutMs: 10000,
          }).then((meta) => {
            if (closed) return;
            const quality = meta.height
              ? qualityFromResolution(meta.width, meta.height)
              : undefined;
            if (meta.durationSec || quality || meta.fileSize) {
              write('metadata', {
                _idx: idx,
                durationSec: meta.durationSec,
                quality,
                width: meta.width,
                height: meta.height,
                fileSize: meta.fileSize,
              });
            }
          }).catch(() => {});
          probePromises.push(probeP);
        },
        onDone: async (result) => {
          // Wait for all probes to finish before closing the stream
          await Promise.allSettled(probePromises);
          write('done', { pageTitle: result.pageTitle, durationMs: result.durationMs });
          reply.raw.end();
        },
        onError: (err) => {
          write('error', { error: err.message });
          reply.raw.end();
        },
      });
    },
  );
}
