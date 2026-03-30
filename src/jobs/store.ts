import type { Job, JobEvent, JobResponse } from './types.js';
import { generateId } from '../utils/id.js';

export class JobStore {
  private jobs = new Map<string, Job>();
  private listeners = new Set<(event: JobEvent) => void>();
  private maxHistory: number;

  constructor(maxHistory: number) {
    this.maxHistory = maxHistory;
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
