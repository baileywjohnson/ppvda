import { chromium, type Browser, type BrowserContext } from 'playwright';
import { interceptNetworkRequests } from './network-interceptor.js';
import { scanDomForVideos } from './dom-scanner.js';
import { autoClickPlay } from './auto-play.js';
import { ExtractionError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getPlaywrightProxy } from '../proxy/index.js';
import type { ExtractionResult, ExtractOptions, VideoSource } from './types.js';

export type { ExtractionResult, ExtractOptions, VideoSource } from './types.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Script injected before any page JS runs to mask headless/automation signals.
 */
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (n) => arr.find(p => p.name === n) || null;
      arr.refresh = () => {};
      return arr;
    },
  });

  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // Chrome runtime stub
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
  }

  // Permissions API — resolve 'notifications' as 'denied' like a real browser
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'denied', onchange: null });
    }
    return origQuery.call(this, params);
  };
`;

const MAX_CONCURRENT_EXTRACTIONS = parseInt(process.env.MAX_CONCURRENT_EXTRACTIONS ?? '3', 10);

class ExtractionSemaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT_EXTRACTIONS) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve(); });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const extractionSem = new ExtractionSemaphore();

let browserInstance: Browser | null = null;
let currentProxyRaw: string | undefined;

async function getBrowser(proxy?: ProxyConfig): Promise<Browser> {
  // If proxy config changed, close and relaunch
  if (browserInstance && currentProxyRaw !== proxy?.raw) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }

  if (!browserInstance) {
    // This browser navigates arbitrary user-supplied URLs, so the bundled
    // Chromium is a direct exposure surface. Keep `playwright` on the latest
    // patch release — dependabot opens weekly PRs (.github/dependabot.yml).
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        // Block direct navigation to private/reserved IP addresses (SSRF defense-in-depth).
        // DNS rebinding is handled by isPrivateUrl double-resolve at the route level.
        '--host-rules='
          + 'MAP 127.* ~NOTFOUND, '
          + 'MAP 10.* ~NOTFOUND, '
          + 'MAP 172.16.* ~NOTFOUND, '
          + 'MAP 172.17.* ~NOTFOUND, '
          + 'MAP 172.18.* ~NOTFOUND, '
          + 'MAP 172.19.* ~NOTFOUND, '
          + 'MAP 172.20.* ~NOTFOUND, '
          + 'MAP 172.21.* ~NOTFOUND, '
          + 'MAP 172.22.* ~NOTFOUND, '
          + 'MAP 172.23.* ~NOTFOUND, '
          + 'MAP 172.24.* ~NOTFOUND, '
          + 'MAP 172.25.* ~NOTFOUND, '
          + 'MAP 172.26.* ~NOTFOUND, '
          + 'MAP 172.27.* ~NOTFOUND, '
          + 'MAP 172.28.* ~NOTFOUND, '
          + 'MAP 172.29.* ~NOTFOUND, '
          + 'MAP 172.30.* ~NOTFOUND, '
          + 'MAP 172.31.* ~NOTFOUND, '
          + 'MAP 192.168.* ~NOTFOUND, '
          + 'MAP 169.254.* ~NOTFOUND, '
          + 'MAP 0.* ~NOTFOUND, '
          // CGNAT (RFC 6598): 100.64.0.0/10
          + 'MAP 100.64.* ~NOTFOUND, MAP 100.65.* ~NOTFOUND, MAP 100.66.* ~NOTFOUND, MAP 100.67.* ~NOTFOUND, '
          + 'MAP 100.68.* ~NOTFOUND, MAP 100.69.* ~NOTFOUND, MAP 100.70.* ~NOTFOUND, MAP 100.71.* ~NOTFOUND, '
          + 'MAP 100.72.* ~NOTFOUND, MAP 100.73.* ~NOTFOUND, MAP 100.74.* ~NOTFOUND, MAP 100.75.* ~NOTFOUND, '
          + 'MAP 100.76.* ~NOTFOUND, MAP 100.77.* ~NOTFOUND, MAP 100.78.* ~NOTFOUND, MAP 100.79.* ~NOTFOUND, '
          + 'MAP 100.80.* ~NOTFOUND, MAP 100.81.* ~NOTFOUND, MAP 100.82.* ~NOTFOUND, MAP 100.83.* ~NOTFOUND, '
          + 'MAP 100.84.* ~NOTFOUND, MAP 100.85.* ~NOTFOUND, MAP 100.86.* ~NOTFOUND, MAP 100.87.* ~NOTFOUND, '
          + 'MAP 100.88.* ~NOTFOUND, MAP 100.89.* ~NOTFOUND, MAP 100.90.* ~NOTFOUND, MAP 100.91.* ~NOTFOUND, '
          + 'MAP 100.92.* ~NOTFOUND, MAP 100.93.* ~NOTFOUND, MAP 100.94.* ~NOTFOUND, MAP 100.95.* ~NOTFOUND, '
          + 'MAP 100.96.* ~NOTFOUND, MAP 100.97.* ~NOTFOUND, MAP 100.98.* ~NOTFOUND, MAP 100.99.* ~NOTFOUND, '
          + 'MAP 100.100.* ~NOTFOUND, MAP 100.101.* ~NOTFOUND, MAP 100.102.* ~NOTFOUND, MAP 100.103.* ~NOTFOUND, '
          + 'MAP 100.104.* ~NOTFOUND, MAP 100.105.* ~NOTFOUND, MAP 100.106.* ~NOTFOUND, MAP 100.107.* ~NOTFOUND, '
          + 'MAP 100.108.* ~NOTFOUND, MAP 100.109.* ~NOTFOUND, MAP 100.110.* ~NOTFOUND, MAP 100.111.* ~NOTFOUND, '
          + 'MAP 100.112.* ~NOTFOUND, MAP 100.113.* ~NOTFOUND, MAP 100.114.* ~NOTFOUND, MAP 100.115.* ~NOTFOUND, '
          + 'MAP 100.116.* ~NOTFOUND, MAP 100.117.* ~NOTFOUND, MAP 100.118.* ~NOTFOUND, MAP 100.119.* ~NOTFOUND, '
          + 'MAP 100.120.* ~NOTFOUND, MAP 100.121.* ~NOTFOUND, MAP 100.122.* ~NOTFOUND, MAP 100.123.* ~NOTFOUND, '
          + 'MAP 100.124.* ~NOTFOUND, MAP 100.125.* ~NOTFOUND, MAP 100.126.* ~NOTFOUND, MAP 100.127.* ~NOTFOUND, '
          // Internal/local DNS suffixes — covers cloud metadata aliases like
          // metadata.google.internal and Kubernetes/Docker *.local.
          + 'MAP *.internal ~NOTFOUND, '
          + 'MAP *.local ~NOTFOUND, '
          // IPv6 loopback and unspecified
          + 'MAP [::1] ~NOTFOUND, '
          + 'MAP [::] ~NOTFOUND, '
          // IPv6 ULA (fc00::/7) and link-local (fe80::/10) — Chromium
          // host-rules glob matches the leading hex chars of a bracketed
          // literal, so [fc..] / [fd..] / [fe80..] all need entries.
          + 'MAP [fc*] ~NOTFOUND, '
          + 'MAP [fd*] ~NOTFOUND, '
          + 'MAP [fe80*] ~NOTFOUND, '
          + 'MAP [fe81*] ~NOTFOUND, '
          + 'MAP [fe82*] ~NOTFOUND, '
          + 'MAP [fe83*] ~NOTFOUND, '
          + 'MAP [fe84*] ~NOTFOUND, '
          + 'MAP [fe85*] ~NOTFOUND, '
          + 'MAP [fe86*] ~NOTFOUND, '
          + 'MAP [fe87*] ~NOTFOUND, '
          + 'MAP [fe88*] ~NOTFOUND, '
          + 'MAP [fe89*] ~NOTFOUND, '
          + 'MAP [fe8a*] ~NOTFOUND, '
          + 'MAP [fe8b*] ~NOTFOUND, '
          + 'MAP [fe8c*] ~NOTFOUND, '
          + 'MAP [fe8d*] ~NOTFOUND, '
          + 'MAP [fe8e*] ~NOTFOUND, '
          + 'MAP [fe8f*] ~NOTFOUND, '
          // 6to4 wrappers of private/loopback IPv4: 2002:0a*::/, 2002:7f*::/,
          // 2002:c0a8*::/, etc. The full 6to4 mapping table would be huge;
          // these cover the most common private-target embeddings.
          + 'MAP [2002:7f*] ~NOTFOUND, '
          + 'MAP [2002:0a*] ~NOTFOUND, '
          + 'MAP [2002:a9fe*] ~NOTFOUND, '
          + 'MAP [2002:c0a8*] ~NOTFOUND, '
          // NAT64 mapping prefix 64:ff9b::/96 wraps any IPv4 (including
          // private). The route-level isPrivateUrl also blocks this.
          + 'MAP [64:ff9b:*] ~NOTFOUND',
      ],
      ...(proxy ? { proxy: getPlaywrightProxy(proxy) } : {}),
    });
    currentProxyRaw = proxy?.raw;
  }

  return browserInstance;
}

async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  await context.addInitScript(STEALTH_SCRIPT);

  return context;
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
  await extractionSem.acquire();
  try {
    return await extractVideosInternal(options);
  } finally {
    extractionSem.release();
  }
}

async function extractVideosInternal(
  options: ExtractOptions & { proxy?: ProxyConfig },
): Promise<ExtractionResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const networkIdleMs = options.networkIdleMs ?? 5000;
  const startTime = Date.now();

  const browser = await getBrowser(options.proxy);
  const context = await createStealthContext(browser);
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

    // Try clicking play buttons to trigger video loading
    if (options.autoPlay) {
      await autoClickPlay(page);
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
  await extractionSem.acquire();
  try {
    await extractVideosStreamingInternal(options);
  } finally {
    extractionSem.release();
  }
}

async function extractVideosStreamingInternal(
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
  const context = await createStealthContext(browser);
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

    // Try clicking play buttons to trigger video loading
    if (options.autoPlay) {
      await autoClickPlay(page);
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
