import type { MediaType } from '../extractor/types.js';

export interface DownloadOptions {
  url: string;
  type: MediaType;
  outputDir: string;
  filename?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface DownloadResult {
  id: string;
  /** Private per-download directory containing filePath; remove with secureRemoveDir. */
  workDir: string;
  filePath: string;
  fileSize: number;
  durationSec?: number;
  format: string;
  success: boolean;
  error?: string;
}
