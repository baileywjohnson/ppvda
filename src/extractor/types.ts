export type VideoType = 'hls' | 'dash' | 'direct';
export type MediaType = VideoType | 'image';
export type DiscoveryMethod = 'network' | 'dom';

export interface VideoSource {
  url: string;
  type: VideoType | MediaType;
  mediaKind: 'video' | 'image';
  mimeType?: string;
  quality?: string;
  fileExtension: string;
  discoveredVia: DiscoveryMethod;
}

export interface ExtractionResult {
  pageUrl: string;
  pageTitle: string;
  videos: VideoSource[];
  extractedAt: string;
  durationMs: number;
}

export interface ExtractOptions {
  url: string;
  timeoutMs?: number;
  networkIdleMs?: number;
  preferredHosts?: string[];
  blockedHosts?: string[];
  allowedHosts?: string[];
  includeImages?: boolean;
}
