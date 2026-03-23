import type { VideoType } from '../extractor/types.js';

export interface DownloadOptions {
  url: string;
  type: VideoType;
  outputDir: string;
  filename?: string;
  timeoutMs?: number;
}

export interface DownloadResult {
  id: string;
  filePath: string;
  fileSize: number;
  durationSec?: number;
  format: string;
  success: boolean;
  error?: string;
}
