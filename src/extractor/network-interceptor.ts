import type { Page, Response } from 'playwright';
import { classifyUrl, isSegmentUrl } from './patterns.js';
import type { VideoSource } from './types.js';

interface InterceptorOptions {
  timeoutMs: number;
  networkIdleMs: number;
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
    if (match && !found.has(url)) {
      found.set(url, {
        url,
        type: match.type,
        mimeType: contentType || undefined,
        quality: match.quality,
        fileExtension: match.fileExtension,
        discoveredVia: 'network',
      });
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
