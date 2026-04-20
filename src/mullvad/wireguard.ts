import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import { ensureDir, secureUnlink } from '../utils/fs.js';
import type { DeviceInfo, RelayServer } from './types.js';

const execFileAsync = promisify(execFile);

const WG_INTERFACE = 'wg0';
const WG_PORT = 51820;

/**
 * Generate a WireGuard config file for connecting to a Mullvad relay.
 */
export function generateWgConfig(device: DeviceInfo, server: RelayServer, gateway: string | null): string {
  // Table = off prevents wg-quick from using fwmark-based policy routing,
  // which requires the net.ipv4.conf.all.src_valid_mark sysctl (a global
  // kernel parameter that can only be set from a privileged container).
  // Instead, PostUp/PreDown manage routes directly.
  //
  // We must add explicit routes for:
  // 1. The relay server's IP — so WireGuard UDP packets reach it via the
  //    original gateway instead of looping through the tunnel.
  // 2. api.mullvad.net (146.70.25.66) — so relay list fetches and device
  //    management still work after the tunnel replaces the default route.
  //
  // PreDown restores the original default route via ${gw}. PostUp uses
  // `replace default dev wg0` which destroys the pre-existing default,
  // and without a symmetric restore, tearing down the tunnel (e.g., on a
  // VPN country switch) leaves the container with no default route at
  // all. The next `startTunnel` then fails at wg-quick's
  // `ip route add <server>/32 via <gw>` step because on-link gateway
  // lookup needs a default route to succeed on some kernels.
  // `ip route replace` is idempotent so it's safe regardless of what the
  // default-route state was when PreDown ran.
  const gw = gateway ?? '172.17.0.1';
  return `[Interface]
PrivateKey = ${device.privateKey}
Address = ${device.ipv4Address}
DNS = 10.64.0.1
Table = off
PostUp = ip route add ${server.ipv4AddrIn}/32 via ${gw} && ip route replace default dev ${WG_INTERFACE}
PreDown = ip route replace default via ${gw} ; ip route del ${server.ipv4AddrIn}/32 via ${gw}

[Peer]
PublicKey = ${server.publicKey}
AllowedIPs = 0.0.0.0/0
Endpoint = ${server.ipv4AddrIn}:${WG_PORT}
`;
}

/**
 * Write WireGuard config and bring up the tunnel.
 */
export async function startTunnel(configDir: string, wgConfig: string): Promise<void> {
  await ensureDir(configDir);

  const configPath = join(configDir, `${WG_INTERFACE}.conf`);
  await writeFile(configPath, wgConfig, { mode: 0o600 });

  try {
    await execFileAsync('wg-quick', ['up', configPath]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start WireGuard tunnel: ${msg}`);
  }

  // Docker manages /etc/resolv.conf and ignores resolvconf.
  // Manually override DNS to use Mullvad's resolver through the tunnel.
  try {
    await writeFile('/etc/resolv.conf', 'nameserver 10.64.0.1\n', { mode: 0o644 });
  } catch {
    // Non-fatal — DNS will use Docker's resolver (less private but functional)
  }
}

/**
 * Tear down the WireGuard tunnel.
 */
export async function stopTunnel(configDir: string): Promise<void> {
  const configPath = join(configDir, `${WG_INTERFACE}.conf`);

  try {
    await execFileAsync('wg-quick', ['down', configPath]);
  } catch {
    // Tunnel may not be up — ignore
  }

  // Restore Docker's default DNS resolver. startTunnel() overwrites
  // /etc/resolv.conf with Mullvad's DNS (10.64.0.1) which becomes
  // unreachable once the tunnel is down, breaking all DNS lookups.
  try {
    await writeFile('/etc/resolv.conf', 'nameserver 127.0.0.11\n', { mode: 0o644 });
  } catch {
    // Non-fatal
  }

  // Securely overwrite the config file before unlinking — it contains the
  // WireGuard private key. secureUnlink writes random bytes + fsyncs before unlink.
  await secureUnlink(configPath).catch(() => {});
}

/**
 * Get the default gateway IP before the tunnel overrides it.
 */
export async function getDefaultGateway(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ip', ['route', 'show', 'default']);
    // "default via 172.17.0.1 dev eth0"
    const match = stdout.match(/default via (\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a hostname to IPs and store the mappings.
 * Must be called BEFORE the tunnel starts (while Docker's DNS is still available).
 */
export async function resolveBypassHost(hostname: string): Promise<string[]> {
  // If it's already an IP, return it directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return [hostname];
  }

  try {
    // Use dns.lookup which checks /etc/hosts first (where Docker puts host.docker.internal)
    const { address } = await dns.lookup(hostname);
    return [address];
  } catch {
    return [];
  }
}

/**
 * Add route exceptions so traffic to specific IPs bypasses the WireGuard tunnel,
 * and write /etc/hosts entries so the hostnames resolve after VPN DNS takes over.
 */
export async function addRouteExceptions(
  hosts: Array<{ hostname: string; ips: string[] }>,
  gateway: string,
): Promise<void> {
  const { appendFile } = await import('node:fs/promises');

  for (const { hostname, ips } of hosts) {
    // Validate hostname to prevent /etc/hosts injection (no newlines, control chars, or spaces)
    if (!/^[a-zA-Z0-9._-]+$/.test(hostname)) continue;

    for (const ip of ips) {
      // Validate IP format
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;

      // Add route to bypass VPN
      try {
        await execFileAsync('ip', ['route', 'add', `${ip}/32`, 'via', gateway]);
      } catch {
        // Route may already exist
      }

      // Add /etc/hosts entry so hostname resolves after VPN DNS takes over
      try {
        await appendFile('/etc/hosts', `${ip} ${hostname}\n`);
      } catch {
        // Non-fatal
      }
    }
  }
}

