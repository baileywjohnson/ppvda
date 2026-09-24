import { AppError } from './errors.js';

/** Thrown when a bounded queue is full. Maps to 503 via the global error handler. */
export class QueueFullError extends AppError {
  constructor() {
    super('Server is busy — try again shortly', 'SERVER_BUSY', 503);
  }
}

/** Thrown when a queued waiter's signal aborts before it got a slot. */
export class AbortedError extends AppError {
  constructor() {
    super('Request was cancelled', 'ABORTED', 499);
  }
}

interface Waiter {
  grant: () => void;
}

/**
 * Counting semaphore with a bounded wait queue. A caller that would have to
 * wait while the queue is already full gets QueueFullError immediately
 * instead of piling up behind everyone else, and a waiter whose signal
 * aborts (client hung up) is removed from the queue rather than being
 * granted a slot for work nobody will receive.
 */
export class BoundedSemaphore {
  private running = 0;
  private queue: Waiter[] = [];

  constructor(private readonly max: number, private readonly maxQueue: number) {}

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) return Promise.reject(new QueueFullError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i !== -1) this.queue.splice(i, 1);
        reject(new AbortedError());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.running++;
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next.grant();
  }
}

/**
 * Per-user cap on concurrent (running + queued) requests to one route, so
 * a single account can't fill a shared queue that every user waits in.
 */
export class PerUserLimiter {
  private active = new Map<string, number>();

  constructor(private readonly maxPerUser: number) {}

  /** Returns an idempotent release function, or null when the user is at the cap. */
  tryAcquire(userId: string): (() => void) | null {
    const count = this.active.get(userId) ?? 0;
    if (count >= this.maxPerUser) return null;
    this.active.set(userId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.active.get(userId) ?? 1;
      if (n <= 1) this.active.delete(userId);
      else this.active.set(userId, n - 1);
    };
  }
}
