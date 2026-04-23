import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** IP address + address family from a validated hostname resolution. */
export interface ResolvedHost {
  /** The resolved IP literal (e.g. "203.0.113.42" or "2606:4700::1111"). */
  address: string;
  /** Address family — 4 for IPv4, 6 for IPv6. Matches the shape Node's dns
   *  lookup callback expects, so this is safe to plug into `http.get`'s
   *  custom `lookup` option. */
  family: 4 | 6;
}

/**
 * Resolve a hostname once, validate the result against all private-IP ranges
 * and obfuscated-form traps, and return the validated address. Returns null
 * (no throw) if the hostname is blocked for any reason so callers can pick
 * their failure mode.
 *
 * This is the one-shot alternative to `isPrivateUrl`'s two-lookup rebinding
 * detection: once you have the address, pin it into the actual HTTP request
 * via Node's `lookup` option so the request never does its own DNS and
 * therefore can't be rebound during the gap.
 */
export async function safeResolveHost(hostname: string): Promise<ResolvedHost | null> {
  if (isPrivateHostname(hostname)) return null;
  if (isObfuscatedIPv4(hostname)) return null;
  try {
    const result = await lookup(hostname);
    if (isPrivateIP(result.address)) return null;
    return {
      address: result.address,
      family: result.family === 6 ? 6 : 4,
    };
  } catch {
    return null;
  }
}

/**
 * Build a Node-style `lookup` function that always returns a pre-validated
 * address, ignoring the actual hostname passed in. Plug this into
 * `http.get` / `https.get`'s `lookup` option so the HTTP client never does
 * its own DNS resolution — closes the DNS-rebinding window between our
 * validation and the actual connect.
 *
 * Handles all three call shapes `dns.lookup` can be invoked with:
 *   lookup(hostname, callback)
 *   lookup(hostname, options, callback)
 *   lookup(hostname, {all: true, ...}, callback)  ← happy-eyeballs, default
 *     on Node 20+ via autoSelectFamily. In this mode the callback's second
 *     arg is an array of {address, family}, not a plain address string;
 *     returning a string here produces a later "Invalid IP address: undefined"
 *     when Node pulls `.address` off the string's first character.
 */
// Matches Node's dns.LookupFunction / socket `lookup` option shape — the
// callback's second arg is `string | LookupAddress[]` depending on the
// `all` flag; we return the right shape per the options.
type PinnedLookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

export function pinnedLookup(resolved: ResolvedHost) {
  return function lookup(
    _hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: PinnedLookupCb,
  ): void {
    let options: { all?: boolean; family?: number } = {};
    let callback: PinnedLookupCb | undefined;
    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback as PinnedLookupCb;
    } else {
      options = (optionsOrCallback ?? {}) as typeof options;
      callback = maybeCallback;
    }
    if (!callback) return;
    if (options.all) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
    } else {
      callback(null, resolved.address, resolved.family);
    }
  };
}

/**
 * Checks if a URL targets a private/reserved IP range.
 * Validates both the literal hostname and the resolved IP.
 * Resolves DNS twice to detect DNS rebinding attacks.
 * Prevents SSRF attacks against internal network services.
 */
export async function isPrivateUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Block obviously private hostnames
    if (isPrivateHostname(hostname)) return true;

    // Reject obfuscated IPv4 encodings outright. Node's URL parser accepts
    // decimal (http://2130706433/), hex (http://0x7f.0.0.1/), and
    // leading-zero octal (http://0177.0.0.1/) forms that skip our
    // isPrivateIP dotted-decimal regexes. getaddrinfo usually normalizes
    // these but the behavior is libc-dependent — reject at the source.
    if (isObfuscatedIPv4(hostname)) return true;

    // Resolve DNS and check the resulting IP (retry once on transient failure)
    let firstAddress: string;
    try {
      const result = await lookup(hostname);
      firstAddress = result.address;
    } catch {
      // Retry once — transient DNS failures are common with CDNs
      try {
        await delay(250);
        const result = await lookup(hostname);
        firstAddress = result.address;
      } catch {
        // DNS resolution failed twice — reject (fail closed)
        return true;
      }
    }

    if (isPrivateIP(firstAddress)) return true;

    // Re-resolve after a short delay to detect DNS rebinding.
    // A rebinding attack flips a public IP to a private one between lookups.
    // Different public IPs (CDN round-robin) are normal and allowed.
    await delay(500);

    try {
      const result2 = await lookup(hostname);
      if (isPrivateIP(result2.address)) return true;
    } catch {
      // Second lookup failed but first already resolved to a public IP — allow
    }

    return false;
  } catch {
    return true; // Malformed URL — treat as private
  }
}

// Match any hostname that's an IPv4 address in a non-dotted-decimal form, OR
// a dotted form containing any hex/octal components. Plain dotted-decimal is
// left alone so isPrivateIP's regexes get their usual shot at it.
function isObfuscatedIPv4(hostname: string): boolean {
  // Strip brackets from bare IPv6 literals; we only care about IPv4 here.
  if (hostname.startsWith('[') && hostname.endsWith(']')) return false;
  // Pure decimal integer host (e.g. "2130706433" = 127.0.0.1).
  if (/^\d+$/.test(hostname) && hostname.length > 0) return true;
  // Dotted form with 1-4 components. Reject any component that's hex-prefixed
  // (0x…) or has a leading zero with length > 1 (octal form).
  const parts = hostname.split('.');
  if (parts.length >= 1 && parts.length <= 4 && parts.every((p) => p.length > 0)) {
    const looksLikeIP = parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p));
    if (!looksLikeIP) return false;
    for (const p of parts) {
      if (/^0x/i.test(p)) return true;
      if (p.length > 1 && p.startsWith('0')) return true;
    }
  }
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === '[::1]' ||
    lower === '[::]' ||
    lower === '::1' ||
    lower === '::'
  );
}

function isPrivateIP(ip: string): boolean {
  // IPv4 private/reserved ranges
  if (/^127\./.test(ip)) return true;                          // loopback
  if (/^10\./.test(ip)) return true;                           // Class A private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;     // Class B private
  if (/^192\.168\./.test(ip)) return true;                     // Class C private
  if (/^169\.254\./.test(ip)) return true;                     // link-local
  if (/^0\./.test(ip)) return true;                            // "this" network
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip)) return true; // CGNAT

  // IPv6 private/reserved
  if (ip === '::1' || ip === '::') return true;                // loopback / all-zeros
  if (/^f[cd]/i.test(ip)) return true;                         // unique local (fc00::/fd00::)
  if (/^fe80:/i.test(ip)) return true;                         // link-local

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateIP(v4mapped[1]);

  return false;
}

/**
 * Like isPrivateUrl but fail-open: only blocks when the resolved IP is
 * *confirmed* private. DNS resolution failures are allowed through because
 * the HTTP client will fail on its own. This is appropriate for redirect
 * targets where the initial URL was already validated at the route level.
 */
export async function isConfirmedPrivateUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    if (isPrivateHostname(hostname)) return true;
    if (isObfuscatedIPv4(hostname)) return true;

    try {
      const result = await lookup(hostname);
      if (isPrivateIP(result.address)) return true;
    } catch {
      return false; // DNS failed — let the HTTP client handle it
    }

    return false;
  } catch {
    return false; // Malformed URL — let the caller handle it
  }
}
