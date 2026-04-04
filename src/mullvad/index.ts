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

interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
}

let activeDevice: DeviceInfo | null = null;
let activeConfig: MullvadConfig | null = null;
let switching = false;

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

/**
 * Switch the VPN to a different country/city by tearing down and
 * rebuilding the WireGuard tunnel with a new relay.
 */
export async function switchMullvadCountry(
  location: string,
  logger: Logger,
  bypassHosts?: string[],
): Promise<{ country: string; city: string }> {
  if (!activeConfig || !activeDevice) {
    throw new Error('Mullvad is not configured');
  }
  if (switching) {
    throw new Error('VPN country switch already in progress');
  }

  switching = true;

  try {
    // Tear down existing tunnel
    await stopTunnel(activeConfig.configDir);
    logger.info('Tunnel stopped for country switch');

    // Capture gateway before new tunnel
    const gateway = await getDefaultGateway();

    // Resolve bypasses
    const resolvedBypasses: Array<{ hostname: string; ips: string[] }> = [];
    if (bypassHosts?.length) {
      for (const host of bypassHosts) {
        const ips = await resolveBypassHost(host);
        if (ips.length > 0) resolvedBypasses.push({ hostname: host, ips });
      }
    }

    // Find new relay
    const relays = await getRelayList();
    const { country, city, server } = findRelay(relays, location);

    // Start new tunnel
    const wgConfig = generateWgConfig(activeDevice, server);
    await startTunnel(activeConfig.configDir, wgConfig);

    // Update stored location
    activeConfig = { ...activeConfig, location };

    logger.info({ country: country.name, city: city.name }, 'Switched VPN country');

    // Re-add bypass routes
    if (gateway && resolvedBypasses.length > 0) {
      await addRouteExceptions(resolvedBypasses, gateway);
    }

    return { country: country.name, city: city.name };
  } finally {
    switching = false;
  }
}

/**
 * Returns true if a VPN country switch is currently in progress.
 */
export function isVpnSwitching(): boolean {
  return switching;
}

/**
 * Get the current VPN status (location + available countries).
 */
export function getVpnStatus(): { configured: boolean; location: string | null } {
  return {
    configured: activeConfig !== null,
    location: activeConfig?.location ?? null,
  };
}

/**
 * Fetch the relay list from Mullvad API. Returns country/city tree.
 */
export async function getRelays(): Promise<Array<{ name: string; code: string; cities: Array<{ name: string; code: string }> }>> {
  const relays = await getRelayList();
  return relays.map((c) => ({
    name: c.name,
    code: c.code,
    cities: c.cities.map((ci) => ({ name: ci.name, code: ci.code })),
  }));
}
