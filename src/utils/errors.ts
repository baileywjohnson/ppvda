export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ExtractionError extends AppError {
  constructor(message: string, code: string = 'EXTRACTION_FAILED') {
    super(message, code, code === 'NO_VIDEOS_FOUND' ? 404 : 502);
  }
}

export class DownloadError extends AppError {
  constructor(message: string, code: string = 'DOWNLOAD_FAILED') {
    super(message, code, 500);
  }
}

export class FfmpegError extends AppError {
  constructor(message: string, code: string = 'FFMPEG_ERROR') {
    super(message, code, 500);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string) {
    super(message, 'TIMEOUT', 504);
  }
}

export class ProxyError extends AppError {
  constructor(message: string) {
    super(message, 'PROXY_ERROR', 502);
  }
}
