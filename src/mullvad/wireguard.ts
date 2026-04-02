import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import { ensureDir } from '../utils/fs.js';
import type { DeviceInfo, RelayServer } from './types.js';

const execFileAsync = promisify(execFile);

const WG_INTERFACE = 'wg0';
const WG_PORT = 51820;

/**
 * Generate a WireGuard config file for connecting to a Mullvad relay.
 */
export function generateWgConfig(device: DeviceInfo, server: RelayServer): string {
  return `[Interface]
PrivateKey = ${device.privateKey}
Address = ${device.ipv4Address}
DNS = 10.64.0.1

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

  await unlink(configPath).catch(() => {});
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
    for (const ip of ips) {
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

/**
 * Save device info to disk so it can be reused across restarts.
 */
export async function saveDeviceInfo(configDir: string, device: DeviceInfo): Promise<void> {
  await ensureDir(configDir);
  const path = join(configDir, 'device.json');
  await writeFile(path, JSON.stringify(device, null, 2), { mode: 0o600 });
}

/**
 * Load previously saved device info, if it exists.
 */
export async function loadDeviceInfo(configDir: string): Promise<DeviceInfo | null> {
  const path = join(configDir, 'device.json');
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data) as DeviceInfo;
  } catch {
    return null;
  }
}
