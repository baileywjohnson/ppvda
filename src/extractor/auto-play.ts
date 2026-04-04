import type { Page } from 'playwright';

/**
 * Combined CSS selector matching common play buttons and video overlays.
 * Uses a single selector string so Playwright can watch for any match at once.
 */
const PLAY_SELECTOR = [
  // Player-specific (most reliable)
  '.jw-icon-display',
  '.vjs-big-play-button',
  '.plyr__control--overlaid',
  '.ytp-large-play-button',
  '.mejs__overlay-play',
  '.flowplayer .fp-ui',

  // Explicit play buttons
  'button[aria-label*="play" i]',
  'button[title*="play" i]',
  '[role="button"][aria-label*="play" i]',

  // Class-based play buttons
  '[class*="play-button"]',
  '[class*="playButton"]',
  '[class*="play_button"]',
  '[class*="play-btn"]',
  '[class*="playBtn"]',
  '[class*="btn-play"]',
  '[class*="btnPlay"]',

  // Video overlays
  '[class*="click-to-play"]',
  '[class*="video-overlay"]',
  '[class*="poster-overlay"]',

  // Generic
  '[data-testid*="play" i]',
].join(', ');

/** How long to wait for a play button to appear in the DOM. */
const WAIT_FOR_PLAY_MS = 3000;

/**
 * Try to trigger video playback on the page:
 * 1. Wait for JS to render (load state)
 * 2. Try calling .play() on any <video> elements
 * 3. Wait for and click a play button if one appears
 *
 * Non-destructive: all failures are silently ignored.
 */
export async function autoClickPlay(page: Page): Promise<void> {
  // Wait for JS frameworks to render — domcontentloaded is too early
  await page.waitForLoadState('load').catch(() => {});

  // Try calling .play() directly on video elements
  const played = await page.evaluate(() => {
    let any = false;
    for (const video of document.querySelectorAll('video')) {
      if (video.paused) {
        video.play().catch(() => {});
        any = true;
      }
    }
    return any;
  }).catch(() => false);

  // If .play() worked on a video, that's likely sufficient
  if (played) return;

  // Wait for a play button to appear, then click it
  try {
    const el = page.locator(PLAY_SELECTOR).first();
    await el.waitFor({ state: 'visible', timeout: WAIT_FOR_PLAY_MS });
    await el.click({ timeout: 2000, force: true });
  } catch {
    // No play button found within timeout — that's fine
  }
}
