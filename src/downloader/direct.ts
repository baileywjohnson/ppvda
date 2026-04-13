import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { DownloadError, TimeoutError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getHttpAgent } from '../proxy/index.js';
import { isConfirmedPrivateUrl } from '../utils/url.js';

export interface DirectDownloadOptions {
  url: string;
  outputPath: string;
  proxyConfig?: ProxyConfig;
  timeoutMs?: number;
  maxRedirects?: number;
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
  } = options;

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await downloadWithRedirects(url, outputPath, {
        proxyConfig,
        timeoutMs,
        maxRedirects,
        redirectCount: 0,
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

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new TimeoutError(`Download timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };

    const req = mod.get(url, { agent, headers }, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.resume(); // drain the response
        isConfirmedPrivateUrl(redirectUrl).then((isPrivate) => {
          if (isPrivate) {
            reject(new DownloadError('Redirect to private/internal URL blocked', 'SSRF_BLOCKED'));
            return;
          }
          downloadWithRedirects(redirectUrl, outputPath, {
            ...opts,
            redirectCount: opts.redirectCount + 1,
          }).then(resolve, reject);
        }).catch(reject);
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

      const fileStream = createWriteStream(outputPath);

      pipeline(res, fileStream)
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
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
