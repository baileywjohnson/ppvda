export type VideoType = 'hls' | 'dash' | 'direct';
export type DiscoveryMethod = 'network' | 'dom';

export interface VideoSource {
  url: string;
  type: VideoType;
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
}
