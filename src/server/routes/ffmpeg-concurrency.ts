import type { FastifyReply } from 'fastify';
import { BoundedSemaphore, PerUserLimiter } from '../../utils/semaphore.js';

const MAX = parseInt(
  process.env.MAX_CONCURRENT_FFMPEG_ROUTES ?? process.env.MAX_CONCURRENT_DOWNLOADS ?? '3',
  10,
);

// Requests waiting for an ffmpeg slot beyond this get 503 instead of
// queueing without bound.
const MAX_QUEUE = 32;

/** Shared by /stream-download and /thumbnail: caps concurrent ffmpeg processes. */
export const ffmpegRouteSem = new BoundedSemaphore(MAX, MAX_QUEUE);

// Per-user caps on running + queued requests. Thumbnails are higher because
// the results grid lazy-loads one <img> per card.
export const streamDownloadUserLimit = new PerUserLimiter(2);
export const thumbnailUserLimit = new PerUserLimiter(8);

/**
 * An AbortSignal that fires if the client goes away before the response
 * has been fully written. Keyed off the response, not the request: since
 * Node 16 IncomingMessage 'close' fires as soon as the request body has
 * been consumed, which says nothing about the client still listening.
 */
export function clientGoneSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  const res = reply.raw;
  const onClose = () => {
    if (!res.writableFinished) ac.abort();
  };
  if (res.destroyed) ac.abort();
  else res.once('close', onClose);
  return ac.signal;
}
