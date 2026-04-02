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
 * Add a route exception so traffic to a specific IP bypasses the WireGuard tunnel
 * and goes through the original default gateway instead.
 */
export async function addRouteException(hostname: string, gateway: string): Promise<void> {
  try {
    // Resolve hostname to IP(s)
    let addresses: string[] = await dns.resolve4(hostname).catch(() => [] as string[]);
    // If it's already an IP, use it directly
    if (addresses.length === 0) {
      const ipMatch = hostname.match(/^\d+\.\d+\.\d+\.\d+$/);
      if (ipMatch) {
        addresses = [hostname];
      }
    }

    for (const ip of addresses) {
      try {
        await execFileAsync('ip', ['route', 'add', `${ip}/32`, 'via', gateway]);
      } catch {
        // Route may already exist — ignore
      }
    }
  } catch {
    // Non-fatal — uploads will just go through VPN
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
