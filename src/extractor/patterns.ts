import type { VideoType, MediaType } from './types.js';

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

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tiff']);

const IMAGE_MIME_PREFIXES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/tiff'];

// Segments — we track these to potentially find their parent manifest
const SEGMENT_EXTENSIONS = new Set(['.ts', '.m4s', '.fmp4']);

export interface PatternMatch {
  type: MediaType;
  mediaKind: 'video' | 'image';
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
  return { type, mediaKind: 'video', fileExtension: ext, quality: detectQuality(url) };
}

/**
 * Check if a URL matches a known image pattern by extension.
 */
export function matchImageByExtension(url: string): PatternMatch | null {
  const ext = getUrlExtension(url);
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return { type: 'image', mediaKind: 'image', fileExtension: ext };
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

  return { type, mediaKind: 'video', fileExtension: extMap[type] };
}

/**
 * Check if a content-type header indicates image content.
 */
export function matchImageByContentType(contentType: string): PatternMatch | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME_PREFIXES.includes(mime)) return null;

  const extMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
  };

  return { type: 'image', mediaKind: 'image', fileExtension: extMap[mime] ?? '.jpg' };
}

/**
 * Check if a URL is a video segment (HLS .ts or DASH .m4s).
 */
export function isSegmentUrl(url: string): boolean {
  return SEGMENT_EXTENSIONS.has(getUrlExtension(url));
}

/**
 * Combined check: is this URL a media source?
 */
export function classifyUrl(
  url: string,
  contentType?: string,
  options?: { includeImages?: boolean },
): PatternMatch | null {
  // Video patterns first
  const byExt = matchByExtension(url);
  if (byExt) return byExt;

  if (contentType) {
    const byMime = matchByContentType(contentType);
    if (byMime) return { ...byMime, quality: detectQuality(url) };
  }

  // Image patterns (only if opted in)
  if (options?.includeImages) {
    const imgExt = matchImageByExtension(url);
    if (imgExt) return imgExt;

    if (contentType) {
      const imgMime = matchImageByContentType(contentType);
      if (imgMime) return imgMime;
    }
  }

  return null;
}

/**
 * Check if a URL looks like a direct link to a media file (video or image).
 */
export function isDirectMediaUrl(url: string): PatternMatch | null {
  const ext = getUrlExtension(url);
  if (VIDEO_EXTENSIONS[ext]) return { type: VIDEO_EXTENSIONS[ext], mediaKind: 'video', fileExtension: ext };
  if (IMAGE_EXTENSIONS.has(ext)) return { type: 'image', mediaKind: 'image', fileExtension: ext };
  return null;
}
