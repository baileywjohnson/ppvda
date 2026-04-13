import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { extractVideos } from '../../extractor/index.js';
import { downloadVideo, selectBestVideo } from '../../downloader/index.js';
import { classifyUrl } from '../../extractor/patterns.js';
import { ExtractionError } from '../../utils/errors.js';
import { downloadRequestSchema, downloadResponseSchema } from '../schemas/download.js';
import type { ProxyConfig } from '../../proxy/types.js';
import type { VideoType, MediaType } from '../../extractor/types.js';
import { isPrivateUrl } from '../../utils/url.js';
import { isVpnSwitching } from '../../mullvad/index.js';
import { resolveProxy, type VpnPermissionStore } from '../vpn-permissions.js';

interface DownloadBody {
  url?: string;
  videoUrl?: string;
  filename?: string;
  timeout?: number;
  useVpn?: boolean;
}

export async function downloadRoutes(
  app: FastifyInstance,
  opts: {
    proxyConfig?: ProxyConfig;
    vpnPermissions: VpnPermissionStore;
    downloadDir: string;
    ffmpegPath: string;
    defaultTimeoutMs: number;
    defaultNetworkIdleMs: number;
    downloadTimeoutMs: number;
    preferredHosts: string[];
    blockedHosts: string[];
    allowedHosts: string[];
    preHandler?: preHandlerHookHandler;
  },
) {
  app.post<{ Body: DownloadBody }>(
    '/download',
    {
      schema: {
        body: downloadRequestSchema,
        response: { 200: downloadResponseSchema },
      },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { url, videoUrl, filename, timeout, useVpn } = request.body;
      const user = (request as any).user;
      const proxy = resolveProxy(useVpn, user.sub, user.isAdmin, opts.vpnPermissions, opts.proxyConfig);

      if (proxy && isVpnSwitching()) {
        throw new ExtractionError('VPN is switching countries, try again in a moment', 'VPN_SWITCHING');
      }

      // Block private/internal URLs
      const urlToCheck = videoUrl ?? url;
      if (urlToCheck && await isPrivateUrl(urlToCheck)) {
        throw new ExtractionError('Private/internal URLs are not allowed', 'PRIVATE_URL_BLOCKED');
      }

      let targetUrl: string;
      let targetType: MediaType;

      if (videoUrl) {
        // Direct video URL provided — skip extraction
        const match = classifyUrl(videoUrl, undefined, { includeImages: true });
        if (!match) {
          throw new ExtractionError(
            'Could not determine video type from the provided URL',
            'UNKNOWN_VIDEO_TYPE',
          );
        }
        targetUrl = videoUrl;
        targetType = match.type;
      } else {
        if (!url) {
          throw new ExtractionError('url is required when videoUrl is not provided', 'VALIDATION_ERROR');
        }
        // Extract videos from the page first
        const extraction = await extractVideos({
          url,
          timeoutMs: timeout ?? opts.defaultTimeoutMs,
          networkIdleMs: opts.defaultNetworkIdleMs,
          proxy,
          preferredHosts: opts.preferredHosts,
          blockedHosts: opts.blockedHosts,
          allowedHosts: opts.allowedHosts,
        });

        if (extraction.videos.length === 0) {
          throw new ExtractionError('No videos found on the page', 'NO_VIDEOS_FOUND');
        }

        const best = selectBestVideo(extraction.videos);
        if (!best) {
          throw new ExtractionError('No suitable video found', 'NO_VIDEOS_FOUND');
        }

        targetUrl = best.url;
        targetType = best.type as MediaType;
      }

      // SSRF: validate the resolved video URL (may differ from the page URL)
      if (await isPrivateUrl(targetUrl)) {
        throw new ExtractionError('Extracted video URL targets a private address', 'PRIVATE_URL_BLOCKED');
      }

      const result = await downloadVideo({
        url: targetUrl,
        type: targetType,
        outputDir: opts.downloadDir,
        filename,
        timeoutMs: opts.downloadTimeoutMs,
        proxy,
        ffmpegPath: opts.ffmpegPath,
      });

      const { filePath: _, ...safeResult } = result;
      return { success: true, data: safeResult };
    },
  );
}
