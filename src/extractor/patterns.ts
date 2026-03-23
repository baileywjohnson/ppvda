import type { VideoType } from './types.js';

const VIDEO_EXTENSIONS: Record<string, VideoType> = {
  '.m3u8': 'hls',
  '.mpd': 'dash',
  '.mp4': 'direct',
  '.webm': 'direct',
  '.mov': 'direct',
  '.avi': 'direct',
  '.flv': 'direct',
  '.mkv': 'direct',
};

const VIDEO_MIME_MAP: Record<string, VideoType> = {
  'application/x-mpegurl': 'hls',
  'application/vnd.apple.mpegurl': 'hls',
  'audio/mpegurl': 'hls',
  'application/dash+xml': 'dash',
  'video/mp4': 'direct',
  'video/webm': 'direct',
  'video/quicktime': 'direct',
  'video/x-flv': 'direct',
  'video/x-matroska': 'direct',
};

// Segments — we track these to potentially find their parent manifest
const SEGMENT_EXTENSIONS = new Set(['.ts', '.m4s', '.fmp4']);

export interface PatternMatch {
  type: VideoType;
  fileExtension: string;
  quality?: string;
}

/**
 * Extract the file extension from a URL, ignoring query params and fragments.
 */
function getUrlExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot === -1) return '';
    return pathname.substring(dot).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Try to detect quality from URL path segments (e.g., "1080p", "720", "hd").
 */
function detectQuality(url: string): string | undefined {
  const match = url.match(/(\d{3,4})p/i);
  if (match) return `${match[1]}p`;

  if (/[/_-]hd[/_.-]/i.test(url)) return 'hd';
  if (/[/_-]sd[/_.-]/i.test(url)) return 'sd';

  return undefined;
}

/**
 * Check if a URL matches a known video pattern by extension.
 */
export function matchByExtension(url: string): PatternMatch | null {
  const ext = getUrlExtension(url);
  const type = VIDEO_EXTENSIONS[ext];
  if (!type) return null;
  return { type, fileExtension: ext, quality: detectQuality(url) };
}

/**
 * Check if a content-type header indicates video content.
 */
export function matchByContentType(contentType: string): PatternMatch | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const type = VIDEO_MIME_MAP[mime];
  if (!type) return null;

  const extMap: Record<VideoType, string> = {
    hls: '.m3u8',
    dash: '.mpd',
    direct: '.mp4',
  };

  return { type, fileExtension: extMap[type] };
}

/**
 * Check if a URL is a video segment (HLS .ts or DASH .m4s).
 */
export function isSegmentUrl(url: string): boolean {
  return SEGMENT_EXTENSIONS.has(getUrlExtension(url));
}

/**
 * Combined check: is this URL a video source?
 */
export function classifyUrl(
  url: string,
  contentType?: string,
): PatternMatch | null {
  const byExt = matchByExtension(url);
  if (byExt) return byExt;

  if (contentType) {
    const byMime = matchByContentType(contentType);
    if (byMime) return { ...byMime, quality: detectQuality(url) };
  }

  return null;
}
