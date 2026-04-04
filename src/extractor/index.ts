import { chromium, type Browser } from 'playwright';
import { interceptNetworkRequests } from './network-interceptor.js';
import { scanDomForVideos } from './dom-scanner.js';
import { ExtractionError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getPlaywrightProxy } from '../proxy/index.js';
import type { ExtractionResult, ExtractOptions, VideoSource } from './types.js';

export type { ExtractionResult, ExtractOptions, VideoSource } from './types.js';

let browserInstance: Browser | null = null;
let currentProxyRaw: string | undefined;

async function getBrowser(proxy?: ProxyConfig): Promise<Browser> {
  // If proxy config changed, close and relaunch
  if (browserInstance && currentProxyRaw !== proxy?.raw) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }

  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      ...(proxy ? { proxy: getPlaywrightProxy(proxy) } : {}),
    });
    currentProxyRaw = proxy?.raw;
  }

  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

export async function extractVideos(
  options: ExtractOptions & { proxy?: ProxyConfig },
): Promise<ExtractionResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const networkIdleMs = options.networkIdleMs ?? 5000;
  const startTime = Date.now();

  const browser = await getBrowser(options.proxy);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Start network interception before navigation
    const interceptor = interceptNetworkRequests(page, {
      timeoutMs,
      networkIdleMs,
      includeImages: options.includeImages,
    });

    // Navigate to the page
    try {
      await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    } catch {
      interceptor.stop();
      throw new ExtractionError(
        'Failed to load page',
        'PAGE_LOAD_FAILED',
      );
    }

    // Wait for network to settle (interceptor resolves on idle or timeout)
    const networkVideos = await interceptor.promise;

    // Scan DOM for additional media sources
    const domVideos = await scanDomForVideos(page, { includeImages: options.includeImages });

    // Get page title
    const pageTitle = await page.title().catch(() => '');

    // Merge, deduplicate, filter blocked hosts, and sort by preferred hosts
    let allVideos = deduplicateVideos([...networkVideos, ...domVideos]);

    if (options.allowedHosts?.length) {
      allVideos = filterAllowedHosts(allVideos, options.allowedHosts);
    } else if (options.blockedHosts?.length) {
      allVideos = filterBlockedHosts(allVideos, options.blockedHosts);
    }

    if (options.preferredHosts?.length) {
      allVideos = sortByPreferredHosts(allVideos, options.preferredHosts);
    }

    const durationMs = Date.now() - startTime;

    return {
      pageUrl: options.url,
      pageTitle,
      videos: allVideos,
      extractedAt: new Date().toISOString(),
      durationMs,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Streaming extraction — emits videos as they're discovered rather than
 * waiting for the full extraction to complete. DOM scan runs in parallel
 * with the network idle wait.
 */
export async function extractVideosStreaming(
  options: ExtractOptions & {
    proxy?: ProxyConfig;
    onVideo: (video: VideoSource) => void;
    onDone: (result: ExtractionResult) => void;
    onError: (error: Error) => void;
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const networkIdleMs = options.networkIdleMs ?? 5000;
  const startTime = Date.now();

  const browser = await getBrowser(options.proxy);
  const context = await browser.newContext();
  const page = await context.newPage();

  // Track all emitted URLs to deduplicate across network + DOM
  const emitted = new Set<string>();

  function emitVideo(video: VideoSource) {
    if (emitted.has(video.url)) return;
    // Apply host filtering before emitting
    const host = getHost(video.url);
    if (options.allowedHosts?.length) {
      if (!options.allowedHosts.some((a) => host === a || host.endsWith(`.${a}`))) return;
    } else if (options.blockedHosts?.length) {
      if (options.blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) return;
    }
    emitted.add(video.url);
    options.onVideo(video);
  }

  try {
    // Start network interception with streaming callback
    const interceptor = interceptNetworkRequests(page, {
      timeoutMs,
      networkIdleMs,
      includeImages: options.includeImages,
      onVideo: emitVideo,
    });

    // Navigate to the page
    try {
      await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    } catch {
      interceptor.stop();
      options.onError(new ExtractionError('Failed to load page', 'PAGE_LOAD_FAILED'));
      return;
    }

    // Run DOM scan and network idle in parallel
    const [networkVideos, domVideos] = await Promise.all([
      interceptor.promise,
      scanDomForVideos(page, { includeImages: options.includeImages }),
    ]);

    // Emit any DOM-discovered videos not already emitted via network
    for (const v of domVideos) {
      emitVideo(v);
    }

    const pageTitle = await page.title().catch(() => '');
    const durationMs = Date.now() - startTime;

    options.onDone({
      pageUrl: options.url,
      pageTitle,
      videos: Array.from(emitted).map(() => ({} as VideoSource)), // not used by caller
      extractedAt: new Date().toISOString(),
      durationMs,
    });
  } catch (err) {
    options.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    await context.close().catch(() => {});
  }
}

function deduplicateVideos(videos: VideoSource[]): VideoSource[] {
  const seen = new Map<string, VideoSource>();
  for (const v of videos) {
    // Prefer network-discovered over DOM-discovered (more reliable)
    const existing = seen.get(v.url);
    if (!existing || (existing.discoveredVia === 'dom' && v.discoveredVia === 'network')) {
      seen.set(v.url, v);
    }
  }
  return Array.from(seen.values());
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function filterAllowedHosts(videos: VideoSource[], allowedHosts: string[]): VideoSource[] {
  return videos.filter((v) => {
    const host = getHost(v.url);
    return allowedHosts.some((a) => host === a || host.endsWith(`.${a}`));
  });
}

function filterBlockedHosts(videos: VideoSource[], blockedHosts: string[]): VideoSource[] {
  return videos.filter((v) => {
    const host = getHost(v.url);
    return !blockedHosts.some((b) => host === b || host.endsWith(`.${b}`));
  });
}

function sortByPreferredHosts(videos: VideoSource[], preferredHosts: string[]): VideoSource[] {
  return [...videos].sort((a, b) => {
    const aHost = getHost(a.url);
    const bHost = getHost(b.url);
    const aIdx = preferredHosts.findIndex((p) => aHost === p || aHost.endsWith(`.${p}`));
    const bIdx = preferredHosts.findIndex((p) => bHost === p || bHost.endsWith(`.${p}`));
    // Preferred hosts come first; among preferred, earlier in the list wins
    const aRank = aIdx === -1 ? preferredHosts.length : aIdx;
    const bRank = bIdx === -1 ? preferredHosts.length : bIdx;
    return aRank - bRank;
  });
}
