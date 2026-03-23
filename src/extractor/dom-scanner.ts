import type { Page } from 'playwright';
import { classifyUrl } from './patterns.js';
import type { VideoSource } from './types.js';

/**
 * Scan the DOM for video-related elements and extract source URLs.
 */
export async function scanDomForVideos(page: Page): Promise<VideoSource[]> {
  const urls = await page.evaluate(() => {
    const results: string[] = [];

    // <video src="..."> and <video><source src="..."></video>
    for (const video of document.querySelectorAll('video')) {
      if (video.src) results.push(video.src);
      if (video.currentSrc) results.push(video.currentSrc);

      for (const source of video.querySelectorAll('source')) {
        if (source.src) results.push(source.src);
      }
    }

    // Standalone <source> elements (outside <video>)
    for (const source of document.querySelectorAll('source')) {
      if (source.src) results.push(source.src);
    }

    // Data attributes commonly used by lazy-loaded players
    const dataAttrs = ['data-src', 'data-video-src', 'data-video-url', 'data-stream-url'];
    for (const attr of dataAttrs) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        const val = el.getAttribute(attr);
        if (val) results.push(val);
      }
    }

    // Check for common player globals
    try {
      // JW Player
      if (typeof (window as any).jwplayer === 'function') {
        const player = (window as any).jwplayer();
        const item = player?.getPlaylistItem?.();
        if (item?.file) results.push(item.file);
        if (item?.sources) {
          for (const s of item.sources) {
            if (s.file) results.push(s.file);
          }
        }
      }
    } catch {}

    try {
      // Video.js
      const vjsPlayers = (window as any).videojs?.getAllPlayers?.();
      if (vjsPlayers) {
        for (const p of vjsPlayers) {
          const src = p.currentSrc?.();
          if (src) results.push(src);
        }
      }
    } catch {}

    return [...new Set(results)];
  });

  const videos: VideoSource[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const match = classifyUrl(url);
    if (match) {
      videos.push({
        url,
        type: match.type,
        quality: match.quality,
        fileExtension: match.fileExtension,
        discoveredVia: 'dom',
      });
    }
  }

  return videos;
}
