import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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
// IPs routed around the VPN tunnel (Mullvad API, Darkreel). See
// setVpnBypassIPs.
let vpnBypassIPs = new Set<string>();

/**
 * Register the IPs that are routed around the VPN tunnel. safeResolveHost —
 * the resolver every extraction/download egress path uses — refuses them,
 * so a user-supplied URL can never be fetched outside the tunnel just
 * because its host shares an IP with a bypass host (e.g. a CDN edge).
 */
export function setVpnBypassIPs(ips: string[]): void {
  vpnBypassIPs = new Set(ips);
}

export async function safeResolveHost(hostname: string): Promise<ResolvedHost | null> {
  if (isBlockedHostLiteral(hostname)) return null;
  const host = stripBrackets(hostname);
  if (vpnBypassIPs.has(host)) return null;
  try {
    // Check every address, not just the first: a name that returns one
    // public and one private record must not be usable, since the caller's
    // connect could otherwise land on either depending on resolver order.
    const results = await lookup(host, { all: true });
    if (results.length === 0 || results.some((r) => isPrivateIP(r.address) || vpnBypassIPs.has(r.address))) return null;
    return {
      address: results[0].address,
      family: results[0].family === 6 ? 6 : 4,
    };
  } catch {
    return null;
  }
}

/**
 * Checks a hostname without resolving it: private names (localhost,
 * *.local, *.internal), obfuscated IPv4 encodings, and IP literals in any
 * blocked range. This is the whole check available when an upstream proxy
 * resolves names — resolving locally too would leak every target hostname
 * to the host's resolver, which the proxy is there to avoid.
 */
export function isBlockedHostLiteral(hostname: string): boolean {
  if (isPrivateHostname(hostname)) return true;
  if (isObfuscatedIPv4(hostname)) return true;
  const host = stripBrackets(hostname);
  return isIP(host) !== 0 && isPrivateIP(host);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
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
export async function isPrivateUrl(url: string, opts: { resolve?: boolean } = {}): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Behind an upstream proxy the proxy resolves names; only the literal
    // checks apply (see isBlockedHostLiteral).
    if (opts.resolve === false) return isBlockedHostLiteral(hostname);
    if (isBlockedHostLiteral(hostname)) return true;
    const host = stripBrackets(hostname);

    // Resolve DNS and check every resulting IP (retry once on transient failure)
    let addresses: string[];
    try {
      addresses = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      // Retry once — transient DNS failures are common with CDNs
      try {
        await delay(250);
        addresses = (await lookup(host, { all: true })).map((r) => r.address);
      } catch {
        // DNS resolution failed twice — reject (fail closed)
        return true;
      }
    }

    if (addresses.length === 0 || addresses.some(isPrivateIP)) return true;

    // Re-resolve after a short delay to detect DNS rebinding.
    // A rebinding attack flips a public IP to a private one between lookups.
    // Different public IPs (CDN round-robin) are normal and allowed.
    await delay(500);

    try {
      const second = await lookup(host, { all: true });
      if (second.some((r) => isPrivateIP(r.address))) return true;
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

// Every range a user-supplied URL must never reach. Checked with
// net.BlockList, which also matches IPv4-mapped IPv6 (::ffff:a.b.c.d in
// either notation) against the IPv4 rules.
const BLOCKED_RANGES: Array<[string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'],        // "this" network
  ['10.0.0.0', 8, 'ipv4'],       // private
  ['100.64.0.0', 10, 'ipv4'],    // CGNAT
  ['127.0.0.0', 8, 'ipv4'],      // loopback
  ['169.254.0.0', 16, 'ipv4'],   // link-local (incl. cloud metadata)
  ['172.16.0.0', 12, 'ipv4'],    // private (incl. Docker bridges)
  ['192.0.0.0', 24, 'ipv4'],     // IETF protocol assignments
  ['192.0.2.0', 24, 'ipv4'],     // TEST-NET-1
  ['192.88.99.0', 24, 'ipv4'],   // 6to4 relay anycast
  ['192.168.0.0', 16, 'ipv4'],   // private
  ['198.18.0.0', 15, 'ipv4'],    // benchmarking
  ['198.51.100.0', 24, 'ipv4'],  // TEST-NET-2
  ['203.0.113.0', 24, 'ipv4'],   // TEST-NET-3
  ['224.0.0.0', 4, 'ipv4'],      // multicast
  ['240.0.0.0', 4, 'ipv4'],      // reserved + broadcast
  ['::', 96, 'ipv6'],            // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96, 'ipv6'],     // NAT64 (wraps any IPv4)
  ['64:ff9b:1::', 48, 'ipv6'],   // local-use NAT64
  ['100::', 64, 'ipv6'],         // discard
  ['2001::', 32, 'ipv6'],        // Teredo (embeds IPv4)
  ['2001:db8::', 32, 'ipv6'],    // documentation
  ['2002::', 16, 'ipv6'],        // 6to4 (embeds IPv4)
  ['fc00::', 7, 'ipv6'],         // unique local
  ['fe80::', 10, 'ipv6'],        // link-local
  ['fec0::', 10, 'ipv6'],        // deprecated site-local
  ['ff00::', 8, 'ipv6'],         // multicast
];

const blockList = new BlockList();
for (const [net, prefix, type] of BLOCKED_RANGES) blockList.addSubnet(net, prefix, type);

/** True for any address in a blocked range — and for anything that isn't an IP literal. */
export function isPrivateIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return blockList.check(ip, 'ipv4');
  if (version === 6) return blockList.check(ip, 'ipv6');
  return true;
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

    if (isBlockedHostLiteral(hostname)) return true;

    try {
      const results = await lookup(stripBrackets(hostname), { all: true });
      if (results.some((r) => isPrivateIP(r.address))) return true;
    } catch {
      return false; // DNS failed — let the HTTP client handle it
    }

    return false;
  } catch {
    return false; // Malformed URL — let the caller handle it
  }
}
