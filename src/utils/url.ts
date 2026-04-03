import { lookup } from 'node:dns/promises';

/**
 * Checks if a URL targets a private/reserved IP range.
 * Validates both the literal hostname and the resolved IP.
 * Prevents SSRF attacks against internal network services.
 */
export async function isPrivateUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Block obviously private hostnames
    if (isPrivateHostname(hostname)) return true;

    // Resolve DNS and check the resulting IP
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIP(address)) return true;
    } catch {
      // DNS resolution failed — allow the request to proceed
      // (ffmpeg/Chromium will fail with a clear error)
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
    lower === '[::1]'
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
  if (ip === '::1') return true;                               // loopback
  if (/^f[cd]/i.test(ip)) return true;                         // unique local
  if (/^fe80:/i.test(ip)) return true;                         // link-local

  return false;
}
