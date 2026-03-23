import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { DownloadError, TimeoutError } from '../utils/errors.js';
import type { ProxyConfig } from '../proxy/types.js';
import { getHttpAgent } from '../proxy/index.js';

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

  await downloadWithRedirects(url, outputPath, {
    proxyConfig,
    timeoutMs,
    maxRedirects,
    redirectCount: 0,
  });
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

    const req = mod.get(url, { agent }, (res) => {
      // Handle redirects
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
        reject(new DownloadError(
          `HTTP ${res.statusCode}`,
          'HTTP_ERROR',
        ));
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
