import type { Page, Response } from 'playwright';
import { classifyUrl, isSegmentUrl } from './patterns.js';
import type { VideoSource } from './types.js';

/** Common ad/tracking domains that serve video-format creatives or beacons */
const AD_DOMAINS = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googleads.g.doubleclick.net',
  'moatads.com',
  'serving-sys.com',
  'adnxs.com',
  'adsrvr.org',
  'adcolony.com',
  'rubiconproject.com',
  'pubmatic.com',
  'casalemedia.com',
  'openx.net',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'amazon-adsystem.com',
  'facebook.net',
  'fbcdn.net',
  'adsafeprotected.com',
  'imasdk.googleapis.com',
  'innovid.com',
  'spotxchange.com',
  'springserve.com',
  'teads.tv',
  'videohub.tv',
  'extremereach.io',
  'sharethrough.com',
]);

function isAdDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const ad of AD_DOMAINS) {
      if (host === ad || host.endsWith(`.${ad}`)) return true;
    }
  } catch {}
  return false;
}

interface InterceptorOptions {
  timeoutMs: number;
  networkIdleMs: number;
  onVideo?: (video: VideoSource) => void;
}

/**
 * Listen to page network responses and collect video URLs.
 * Resolves when:
 * - No new network activity for `networkIdleMs`, OR
 * - Overall `timeoutMs` is reached
 */
export function interceptNetworkRequests(
  page: Page,
  options: InterceptorOptions,
): { promise: Promise<VideoSource[]>; stop: () => void } {
  const found = new Map<string, VideoSource>();
  const segmentParents = new Set<string>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const { promise, resolve } = createDeferred<VideoSource[]>();

  function finish() {
    if (stopped) return;
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    resolve(Array.from(found.values()));
  }

  function resetIdle() {
    if (stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, options.networkIdleMs);
  }

  // Overall timeout
  const overallTimeout = setTimeout(finish, options.timeoutMs);

  const onResponse = (response: Response) => {
    if (stopped) return;

    const url = response.url();
    const contentType = response.headers()['content-type'] ?? '';

    // Check for video segments — try to reconstruct parent manifest
    if (isSegmentUrl(url)) {
      try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.split('/');
        pathParts.pop(); // remove segment filename
        const parentBase = `${parsed.origin}${pathParts.join('/')}`;
        segmentParents.add(parentBase);
      } catch {
        // ignore malformed URLs
      }
      resetIdle();
      return;
    }

    const match = classifyUrl(url, contentType);
    if (match && !found.has(url) && !isAdDomain(url)) {
      const video: VideoSource = {
        url,
        type: match.type,
        mimeType: contentType || undefined,
        quality: match.quality,
        fileExtension: match.fileExtension,
        discoveredVia: 'network',
      };
      found.set(url, video);
      options.onVideo?.(video);
    }

    resetIdle();
  };

  page.on('response', onResponse);

  // Start the idle timer immediately (in case page has no network activity)
  resetIdle();

  function stop() {
    clearTimeout(overallTimeout);
    page.removeListener('response', onResponse);
    finish();
  }

  return { promise, stop };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
