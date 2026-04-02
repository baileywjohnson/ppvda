import { generateWireGuardKeys } from './keys.js';
import { getAccessToken, createDevice, removeDevice, getRelayList, findRelay } from './api.js';
import {
  generateWgConfig,
  startTunnel,
  stopTunnel,
  saveDeviceInfo,
  loadDeviceInfo,
  getDefaultGateway,
  resolveBypassHost,
  addRouteExceptions,
} from './wireguard.js';
import type { MullvadConfig, DeviceInfo } from './types.js';
import type { Logger } from 'pino';

let activeDevice: DeviceInfo | null = null;
let activeConfig: MullvadConfig | null = null;

/**
 * Set up a Mullvad VPN connection via WireGuard.
 *
 * Flow:
 * 1. Check for a cached device (from a previous run)
 * 2. If no cached device, generate keys and register with Mullvad
 * 3. Fetch relay list and pick a server matching the requested location
 * 4. Generate WireGuard config and bring up the tunnel
 */
export async function setupMullvad(
  config: MullvadConfig,
  logger: Logger,
  bypassHosts?: string[],
): Promise<void> {
  activeConfig = config;

  // Try to reuse a previously registered device
  let device = await loadDeviceInfo(config.configDir);

  if (device) {
    logger.info('Reusing cached Mullvad device');
  } else {
    logger.info('Registering new Mullvad device...');

    const token = await getAccessToken(config.accountNumber);
    const keys = generateWireGuardKeys();
    device = await createDevice(token, keys);

    await saveDeviceInfo(config.configDir, device);
    logger.info('Mullvad device registered');
  }

  activeDevice = device;

  // Capture default gateway BEFORE tunnel overrides routing
  const gateway = await getDefaultGateway();

  // Resolve bypass hostnames BEFORE tunnel starts (while Docker DNS is available)
  const resolvedBypasses: Array<{ hostname: string; ips: string[] }> = [];
  if (bypassHosts?.length) {
    for (const host of bypassHosts) {
      const ips = await resolveBypassHost(host);
      if (ips.length > 0) {
        resolvedBypasses.push({ hostname: host, ips });
        logger.info({ host, ips }, 'Resolved VPN bypass host');
      } else {
        logger.warn({ host }, 'Could not resolve VPN bypass host');
      }
    }
  }

  // Fetch relay list and find matching server
  logger.info('Finding Mullvad relay...');
  const relays = await getRelayList();
  const { server } = findRelay(relays, config.location);

  // Generate config and start tunnel
  const wgConfig = generateWgConfig(device, server);
  await startTunnel(config.configDir, wgConfig);

  logger.info('WireGuard tunnel is up — all traffic routed through Mullvad');

  // Add route exceptions + /etc/hosts entries for bypass hosts
  if (gateway && resolvedBypasses.length > 0) {
    await addRouteExceptions(resolvedBypasses, gateway);
    logger.info('VPN bypass routes added');
  }
}

/**
 * Tear down the Mullvad VPN connection.
 * Optionally removes the device from the Mullvad account.
 */
export async function teardownMullvad(
  logger: Logger,
  opts: { removeDevice: boolean } = { removeDevice: false },
): Promise<void> {
  if (!activeConfig) return;

  await stopTunnel(activeConfig.configDir);
  logger.info('WireGuard tunnel stopped');

  if (opts.removeDevice && activeDevice && activeConfig) {
    try {
      const token = await getAccessToken(activeConfig.accountNumber);
      await removeDevice(token, activeDevice.id);
      logger.info('Mullvad device removed');
    } catch {
      logger.warn('Failed to remove Mullvad device (non-fatal)');
    }
  }

  activeDevice = null;
  activeConfig = null;
}
