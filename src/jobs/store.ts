import type { Job, JobEvent, JobResponse } from './types.js';
import { generateId } from '../utils/id.js';

const JOB_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

export class JobStore {
  private jobs = new Map<string, Job>();
  private listeners = new Set<(event: JobEvent) => void>();
  private maxHistory: number;
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(maxHistory: number) {
    this.maxHistory = maxHistory;
    // Periodically mark stuck jobs as failed
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  private sweepStale() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status === 'done' || job.status === 'failed') continue;
      const updated = new Date(job.updatedAt).getTime();
      if (now - updated > JOB_TIMEOUT_MS) {
        this.update(job.id, { status: 'failed', error: 'Job timed out' });
      }
    }
  }

  create(userId: string): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: generateId(),
      userId,
      status: 'extracting',
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.emit(job);
    this.evict();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(userId?: string): JobResponse[] {
    let jobs = [...this.jobs.values()];
    if (userId) {
      jobs = jobs.filter((j) => j.userId === userId);
    }
    jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return jobs.map(stripInternal);
  }

  update(id: string, patch: Partial<Job>): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    // Clear sensitive metadata from terminal jobs to minimize retained info
    if (job.status === 'done' || job.status === 'failed') {
      job.filePath = undefined;
      job.fileSize = undefined;
      job.durationSec = undefined;
      job.format = undefined;
      job.videoType = undefined;
    }
    this.emit(job);
    return job;
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(job: Job) {
    const event: JobEvent = {
      jobId: job.id,
      status: job.status,
      updatedAt: job.updatedAt,
      error: job.error,
      fileSize: job.fileSize,
      durationSec: job.durationSec,
      darkreelMediaId: job.darkreelMediaId,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener error — ignore
      }
    }
  }

  private evict() {
    if (this.jobs.size <= this.maxHistory) return;
    const sorted = [...this.jobs.entries()].sort(
      ([, a], [, b]) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const terminal = sorted.filter(([, j]) => j.status === 'done' || j.status === 'failed');
    for (const [id] of terminal) {
      if (this.jobs.size <= this.maxHistory) break;
      this.jobs.delete(id);
    }
  }
}

function stripInternal(job: Job): JobResponse {
  const { filePath: _, userId: _u, ...rest } = job;
  return rest;
}
