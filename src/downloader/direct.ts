import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { DownloadError, TimeoutError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getHttpAgent } from '../proxy/index.js';
import { pinnedLookup, safeResolveHost } from '../utils/url.js';

export interface DirectDownloadOptions {
  url: string;
  outputPath: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
}

/**
 * Download a file directly via HTTP(S), optionally through a proxy.
 */
export async function downloadDirect(options: DirectDownloadOptions): Promise<void> {
  const {
    url,
    outputPath,
    proxyConfig,
    timeoutMs = 300000,
    maxRedirects = 5,
    maxBytes,
  } = options;

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await downloadWithRedirects(url, outputPath, {
        proxyConfig,
        timeoutMs,
        maxRedirects,
        redirectCount: 0,
        maxBytes,
      });
      return;
    } catch (err) {
      if (
        err instanceof DownloadError &&
        err.message.startsWith('HTTP 429') &&
        attempt < maxRetries
      ) {
        const waitSec = (err as any).retryAfter ?? (2 ** attempt * 2);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }
}

interface InternalOptions {
  proxyConfig?: ProxyConfig;
  timeoutMs: number;
  maxRedirects: number;
  redirectCount: number;
  maxBytes?: number;
}

async function downloadWithRedirects(
  url: string,
  outputPath: string,
  opts: InternalOptions,
): Promise<void> {
  if (opts.redirectCount >= opts.maxRedirects) {
    throw new DownloadError(`Too many redirects (>${opts.maxRedirects})`, 'TOO_MANY_REDIRECTS');
  }

  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const mod = isHttps ? https : http;

  const agent = opts.proxyConfig ? getHttpAgent(opts.proxyConfig) : undefined;

  // Resolve-and-pin DNS for this request. When a proxy agent is in play the
  // proxy does its own resolution, so skip pinning in that case (the operator
  // opted into that proxy and trusts its network). Otherwise we resolve the
  // hostname once, validate, and hand http.get a `lookup` that returns the
  // pinned address — so Node's HTTP client never re-resolves and the URL
  // validator's answer can't be invalidated by a rebinding attack between
  // check and connect.
  let pinnedLookupFn: ReturnType<typeof pinnedLookup> | undefined;
  if (!agent) {
    const resolved = await safeResolveHost(parsed.hostname);
    if (!resolved) {
      throw new DownloadError(
        `Host ${parsed.hostname} resolves to a private/internal address or failed DNS`,
        'SSRF_BLOCKED',
      );
    }
    pinnedLookupFn = pinnedLookup(resolved);
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new TimeoutError(`Download timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };

    const req = mod.get(url, { agent, headers, lookup: pinnedLookupFn }, (res) => {
      // Handle redirects. Re-validation happens inside the recursive
      // downloadWithRedirects via safeResolveHost — that way the lookup
      // we validate against and the lookup we actually connect on are
      // literally the same one (pinned). A separate up-front check
      // would be a second DNS query that could disagree due to rebinding.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume(); // drain the response
        downloadWithRedirects(redirectUrl, outputPath, {
          ...opts,
          redirectCount: opts.redirectCount + 1,
        }).then(resolve, reject);
        return;
      }

      if (!res.statusCode || res.statusCode >= 400) {
        clearTimeout(timeout);
        const err = new DownloadError(
          `HTTP ${res.statusCode}`,
          'HTTP_ERROR',
        );
        if (res.statusCode === 429 && res.headers['retry-after']) {
          const parsed = parseInt(res.headers['retry-after'] as string, 10);
          if (!isNaN(parsed)) (err as any).retryAfter = parsed;
        }
        reject(err);
        return;
      }

      // Reject up-front if Content-Length exceeds the cap.
      if (opts.maxBytes !== undefined) {
        const contentLength = parseInt(res.headers['content-length'] ?? '', 10);
        if (!isNaN(contentLength) && contentLength > opts.maxBytes) {
          clearTimeout(timeout);
          req.destroy();
          reject(new DownloadError(
            `Response exceeds max size (${contentLength} > ${opts.maxBytes} bytes)`,
            'SIZE_EXCEEDED',
          ));
          return;
        }
      }

      const fileStream = createWriteStream(outputPath);

      // Track bytes during streaming in case Content-Length was absent,
      // incorrect, or the server sends an unbounded/chunked response.
      let bytesReceived = 0;
      if (opts.maxBytes !== undefined) {
        const cap = opts.maxBytes;
        res.on('data', (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (bytesReceived > cap) {
            req.destroy(new DownloadError(
              `Response exceeded max size (>${cap} bytes)`,
              'SIZE_EXCEEDED',
            ));
          }
        });
      }

      pipeline(res, fileStream)
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
          if (err instanceof DownloadError) {
            reject(err);
            return;
          }
          reject(new DownloadError(
            `Write failed: ${err.message}`,
            'WRITE_ERROR',
          ));
        });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(new DownloadError(`Download failed: ${err.message}`, 'NETWORK_ERROR'));
    });
  });
}
