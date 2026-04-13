import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

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
