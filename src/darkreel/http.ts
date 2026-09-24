import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../utils/errors.js';
import { isBlockedHostLiteral, isPrivateIP, pinnedLookup, type ResolvedHost } from '../utils/url.js';

// Transport for every request PPVDA makes to a Darkreel server. The server
// URL is user-supplied and stored, so each call re-validates it, resolves
// the host once, and connects to exactly the address that was validated
// (DNS pinning — a rebinding resolver can't swap in an internal address
// between check and connect). Response bodies are read with a small cap:
// Darkreel's replies are short JSON, and anything bigger is refused
// rather than buffered.
//
// Policy: a Darkreel URL connected by an admin may use plain http and may
// point at a private/internal host (same-host or LAN deployments). For
// everyone else it must be https to a public address. "Admin" is read from
// the DB by the caller at the time of each call, so a demotion takes
// effect on the next upload.
//
// Unlike safeResolveHost, the VPN bypass IPs are not refused here: the
// Darkreel host is exactly what the bypass list exists for.

/** Cap on any response body read from a Darkreel server. */
export const MAX_DARKREEL_RESPONSE_BYTES = 64 * 1024;

export type DarkreelErrorCode =
  | 'INVALID_URL'        // not a bare http(s) origin
  | 'INSECURE_URL'       // http:// without admin rights
  | 'PRIVATE_HOST'       // resolves to a private/internal address
  | 'UNREACHABLE'        // DNS failure, connect/TLS/socket error
  | 'TIMEOUT'
  | 'ABORTED'
  | 'RESPONSE_TOO_LARGE'
  | 'BAD_RESPONSE'       // malformed or out-of-contract response body
  | 'SCOPE_MISMATCH'     // delegation is not upload-scoped
  | 'REVOKED'            // refresh token rejected
  | 'HTTP_STATUS';       // any other non-2xx

/**
 * Error from the Darkreel client. `code` (and `status` for HTTP errors) is
 * all callers log: messages never carry the server's hostname, URL, or
 * response text.
 */
export class DarkreelError extends AppError {
  constructor(code: DarkreelErrorCode, public readonly status?: number) {
    super(status !== undefined ? `Darkreel request failed (${code}, HTTP ${status})` : `Darkreel request failed (${code})`, code, 502);
  }
}

/**
 * Reduce a user-supplied Darkreel URL to its origin, refusing anything
 * that isn't a bare origin: credentials, a path other than "/", a query or
 * a fragment. Plain http is accepted only for admins.
 */
export function normalizeDarkreelOrigin(serverUrl: string, admin: boolean): string {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    throw new DarkreelError('INVALID_URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DarkreelError('INVALID_URL');
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new DarkreelError('INVALID_URL');
  }
  // Catch a bare "?" or "#" too, which URL normalises away.
  if (/[?#]/.test(serverUrl)) throw new DarkreelError('INVALID_URL');
  if (u.protocol === 'http:' && !admin) throw new DarkreelError('INSECURE_URL');
  return u.origin;
}

/** A validated origin plus the one address every connection to it uses. */
export interface DarkreelTarget {
  origin: URL;
  resolved: ResolvedHost;
}

/**
 * Validate `serverUrl` under the policy above and resolve its host once.
 * Every address the name resolves to is checked, not just the first.
 */
export async function resolveDarkreelTarget(serverUrl: string, admin: boolean): Promise<DarkreelTarget> {
  const origin = new URL(normalizeDarkreelOrigin(serverUrl, admin));
  const host = origin.hostname.startsWith('[') ? origin.hostname.slice(1, -1) : origin.hostname;

  if (!admin && isBlockedHostLiteral(origin.hostname)) throw new DarkreelError('PRIVATE_HOST');

  let results: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    results = [{ address: host, family: isIP(host) }];
  } else {
    try {
      results = await lookup(host, { all: true });
    } catch {
      throw new DarkreelError('UNREACHABLE');
    }
  }
  if (results.length === 0) throw new DarkreelError('UNREACHABLE');
  if (!admin && results.some((r) => isPrivateIP(r.address))) throw new DarkreelError('PRIVATE_HOST');
  return {
    origin,
    resolved: { address: results[0].address, family: results[0].family === 6 ? 6 : 4 },
  };
}

export interface DarkreelResponse {
  status: number;
  body: Buffer;
}

/**
 * POST to `path` on a resolved Darkreel target. `body` is either a buffer
 * or an async iterable streamed with backpressure (chunked encoding), so an
 * upload never has to exist in memory as a whole. Redirects are not
 * followed. The response body is capped at MAX_DARKREEL_RESPONSE_BYTES.
 *
 * Settles only after the request body stream has stopped, so a caller's
 * `finally` (e.g. zeroing keys the body generator uses) can't run while a
 * chunk is still being produced.
 */
export function darkreelPost(
  target: DarkreelTarget,
  path: string,
  opts: {
    headers: Record<string, string>;
    body: Buffer | AsyncIterable<Buffer>;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<DarkreelResponse> {
  const { origin, resolved } = target;
  const mod = origin.protocol === 'https:' ? https : http;

  return new Promise<DarkreelResponse>((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    let bodyDone: Promise<void> = Promise.resolve();

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      void bodyDone.then(fn);
    };
    const fail = (err: DarkreelError) => {
      req.destroy();
      settle(() => reject(err));
    };

    const req = mod.request({
      protocol: origin.protocol,
      hostname: origin.hostname.startsWith('[') ? origin.hostname.slice(1, -1) : origin.hostname,
      port: origin.port || undefined,
      path,
      method: 'POST',
      headers: opts.headers,
      lookup: pinnedLookup(resolved),
      // A fresh connection per call: a pooled keep-alive socket would skip
      // the pinned lookup for this call.
      agent: false,
    }, (res) => {
      gotResponse = true;
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DARKREEL_RESPONSE_BYTES) {
          res.destroy();
          fail(new DarkreelError('RESPONSE_TOO_LARGE', status));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        // The server may answer (typically with an error) before the
        // upload body is fully sent; stop sending the rest.
        if (!req.writableFinished) req.destroy();
        settle(() => resolve({ status, body: Buffer.concat(chunks) }));
      });
      res.on('close', () => {
        if (!res.complete) fail(new DarkreelError('UNREACHABLE'));
      });
    });

    req.on('error', () => {
      // Once a response is in, its own events decide the outcome — a write
      // error from the server closing early must not mask its status.
      if (!gotResponse) fail(new DarkreelError('UNREACHABLE'));
    });

    const timer = setTimeout(() => fail(new DarkreelError('TIMEOUT')), opts.timeoutMs);
    const onAbort = () => fail(new DarkreelError('ABORTED'));
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    if (Buffer.isBuffer(opts.body)) {
      req.end(opts.body);
    } else {
      bodyDone = pipeline(Readable.from(opts.body, { objectMode: false }), req).catch((err) => {
        if (!gotResponse) fail(err instanceof DarkreelError ? err : new DarkreelError('UNREACHABLE'));
      });
    }
  });
}

/** POST a JSON body and parse a JSON object reply; non-2xx → HTTP_STATUS. */
export async function darkreelPostJson(
  target: DarkreelTarget,
  path: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const res = await darkreelPost(target, path, {
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload), 'utf-8'),
    timeoutMs,
    signal,
  });
  if (res.status < 200 || res.status >= 300) return { status: res.status, data: null };
  try {
    const data: unknown = JSON.parse(res.body.toString('utf-8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error();
    return { status: res.status, data: data as Record<string, unknown> };
  } catch {
    throw new DarkreelError('BAD_RESPONSE', res.status);
  }
}

/**
 * SHA-256 of the raw 32-byte X25519 public key, lowercase hex. Shown in
 * Settings so a user can check it against the key Darkreel reports for
 * their account — a key swapped in transit would seal every upload to
 * someone else.
 */
export function publicKeyFingerprint(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}
