export type JobStatus = 'extracting' | 'downloading' | 'encrypting' | 'done' | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  // Progress info (no URLs — privacy)
  videoType?: string;
  fileSize?: number;
  durationSec?: number;
  format?: string;
  /** Internal only — not exposed via API */
  filePath?: string;
  darkreelMediaId?: string;
}

export interface JobEvent {
  jobId: string;
  status: JobStatus;
  updatedAt: string;
  error?: string;
  fileSize?: number;
  durationSec?: number;
  darkreelMediaId?: string;
}

/** What the API returns — filePath stripped */
export type JobResponse = Omit<Job, 'filePath'>;
