class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const MAX = parseInt(
  process.env.MAX_CONCURRENT_FFMPEG_ROUTES ?? process.env.MAX_CONCURRENT_DOWNLOADS ?? '3',
  10,
);

export const ffmpegRouteSem = new Semaphore(MAX);
