import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
Address = ${device.ipv4Address}, ${device.ipv6Address}
DNS = 10.64.0.1

[Peer]
PublicKey = ${server.publicKey}
AllowedIPs = 0.0.0.0/0, ::/0
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
