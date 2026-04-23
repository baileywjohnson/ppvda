import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import http from 'node:http';
import https from 'node:https';
import { extractVideos, extractVideosStreaming } from '../../extractor/index.js';
import { extractRequestSchema, extractResponseSchema } from '../schemas/extract.js';
import { probeVideo, qualityFromResolution } from '../../downloader/probe.js';
import type { ProxyConfig } from '../../proxy/types.js';
import { getHttpAgent } from '../../proxy/index.js';
import { isPrivateUrl, pinnedLookup, safeResolveHost } from '../../utils/url.js';
import { isVpnSwitching } from '../../mullvad/index.js';
import { resolveProxy, type VpnPermissionStore } from '../vpn-permissions.js';

// HEAD an image URL and return its Content-Length. Best-effort —
// returns undefined on any failure (non-2xx, missing header, timeout,
// DNS resolves to a private IP). Uses the same DNS-pinning pattern as
// downloadDirect so a rebinding server can't flip the resolved address
// between our `safeResolveHost` check and the actual connect.
async function headImageSize(url: string, proxy: ProxyConfig | undefined): Promise<number | undefined> {
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return undefined;

  const agent = proxy ? getHttpAgent(proxy) : undefined;
  let lookup: ReturnType<typeof pinnedLookup> | undefined;
  if (!agent) {
    const resolved = await safeResolveHost(parsed.hostname);
    if (!resolved) return undefined;
    lookup = pinnedLookup(resolved);
  }
  const mod = parsed.protocol === 'https:' ? https : http;

  return new Promise<number | undefined>((resolve) => {
    const req = mod.request(url, { method: 'HEAD', agent, lookup, timeout: 8000 }, (res) => {
      res.resume();
      if (!res.statusCode || res.statusCode >= 400) { resolve(undefined); return; }
      const len = parseInt(String(res.headers['content-length'] ?? ''), 10);
      resolve(Number.isFinite(len) && len > 0 ? len : undefined);
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.end();
  });
}

interface ExtractBody {
  url: string;
  timeout?: number;
  useVpn?: boolean;
  includeImages?: boolean;
  autoPlay?: boolean;
}

// Per-user SSE connection cap. A single SSE stream can be held open for the
// full duration of extraction + background ffprobe calls (potentially minutes).
// Without a cap, one user could exhaust file descriptors and memory by opening
// many concurrent streams. Per-user (not global) so one user can't starve others.
const MAX_SSE_PER_USER = 3;
const sseConnections = new Map<string, number>();

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

      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reply.status(400).send({ success: false, error: 'Only http/https URLs are supported' });
          return;
        }
      } catch {
        reply.status(400).send({ success: false, error: 'Invalid URL' });
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

      // Enforce per-user SSE cap before any other work
      const currentCount = sseConnections.get(user.sub) ?? 0;
      if (currentCount >= MAX_SSE_PER_USER) {
        reply.status(503).send({ success: false, error: 'Too many concurrent extraction streams — close existing ones and retry' });
        return;
      }

      if (proxy && isVpnSwitching()) {
        reply.status(503).send({ success: false, error: 'VPN is switching countries, try again in a moment' });
        return;
      }

      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify({ success: false, error: 'Only http/https URLs are supported' }));
          return;
        }
      } catch {
        reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ success: false, error: 'Invalid URL' }));
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

      // Register this connection now that we've committed to streaming.
      sseConnections.set(user.sub, currentCount + 1);
      let released = false;
      const releaseSlot = () => {
        if (released) return;
        released = true;
        const count = sseConnections.get(user.sub) ?? 1;
        if (count <= 1) sseConnections.delete(user.sub);
        else sseConnections.set(user.sub, count - 1);
      };

      let closed = false;
      request.raw.on('close', () => { closed = true; releaseSlot(); });

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

          // Fire off enrichment in the background, then ALWAYS emit a
          // metadata event when it settles — the frontend uses that
          // event as the signal to clear the card's probe spinner and
          // enable the Download / Upload buttons. Gating the emit on
          // "did the probe produce anything" (the old behavior) meant
          // direct image URLs — for which ffprobe has nothing useful
          // to say — left the card stuck in the waiting state forever.
          const isImage = video.mediaKind === 'image' || video.type === 'image';
          const enrichP = isImage
            ? headImageSize(video.url, proxy).then((fileSize) => ({ fileSize }))
            : probeVideo({
                url: video.url,
                ffprobePath: opts.ffmpegPath.replace(/ffmpeg$/, 'ffprobe'),
                proxyConfig: proxy,
                timeoutMs: 10000,
              }).then((meta) => ({
                durationSec: meta.durationSec,
                quality: meta.height ? qualityFromResolution(meta.width, meta.height) : undefined,
                width: meta.width,
                height: meta.height,
                fileSize: meta.fileSize,
              }));
          const probeP = enrichP
            .catch(() => ({} as Record<string, unknown>))
            .then((enrichment) => {
              if (closed) return;
              write('metadata', { _idx: idx, ...enrichment });
            });
          probePromises.push(probeP);
        },
        onDone: async (result) => {
          // Wait for all probes to finish before closing the stream
          await Promise.allSettled(probePromises);
          write('done', { pageTitle: result.pageTitle, durationMs: result.durationMs });
          reply.raw.end();
          releaseSlot();
        },
        onError: (err) => {
          write('error', { error: err.message });
          reply.raw.end();
          releaseSlot();
        },
      });
    },
  );
}
