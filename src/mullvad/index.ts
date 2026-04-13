import { generateWireGuardKeys } from './keys.js';
import { getAccessToken, createDevice, removeDevice, listDevices, getRelayList, findRelay } from './api.js';
import {
  generateWgConfig,
  startTunnel,
  stopTunnel,
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
 * 1. Generate fresh WireGuard keys and register with Mullvad
 * 2. Fetch relay list and pick a server matching the requested location
 * 3. Generate WireGuard config and bring up the tunnel
 */
export async function setupMullvad(
  config: MullvadConfig,
  logger: Logger,
  bypassHosts?: string[],
): Promise<void> {
  activeConfig = config;

  // Always generate fresh keys on startup
  logger.info('Registering new Mullvad device...');
  const token = await getAccessToken(config.accountNumber);
  const keys = generateWireGuardKeys();

  let device: DeviceInfo;
  try {
    device = await createDevice(token, keys);
  } catch (err) {
    // If max devices reached, remove the oldest and retry
    if (err instanceof Error && err.message.includes('MAX_DEVICES_REACHED')) {
      logger.warn('Max Mullvad devices reached, removing oldest device...');
      const devices = await listDevices(token);
      if (devices.length > 0) {
        const oldest = devices.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime())[0];
        await removeDevice(token, oldest.id);
        logger.info({ removedDevice: oldest.name }, 'Removed oldest Mullvad device');
      }
      device = await createDevice(token, keys);
    } else {
      throw err;
    }
  }

  logger.info('Mullvad device registered');

  activeDevice = device;

  // Capture default gateway BEFORE tunnel overrides routing
  const gateway = await getDefaultGateway();

  // Resolve bypass hostnames BEFORE tunnel starts (while Docker DNS is available).
  // Always include api.mullvad.net so relay list fetches and device management
  // work after the tunnel replaces the default route.
  const allBypassHosts = ['api.mullvad.net', ...(bypassHosts ?? [])];
  const resolvedBypasses: Array<{ hostname: string; ips: string[] }> = [];
  for (const host of allBypassHosts) {
    const ips = await resolveBypassHost(host);
    if (ips.length > 0) {
      resolvedBypasses.push({ hostname: host, ips });
      logger.info({ host, ips }, 'Resolved VPN bypass host');
    } else {
      logger.warn({ host }, 'Could not resolve VPN bypass host');
    }
  }

  // Fetch relay list and find matching server
  logger.info('Finding Mullvad relay...');
  const relays = await getRelayList();
  const { server } = findRelay(relays, config.location);

  // Ensure no stale tunnel from a previous crash/SIGKILL before starting
  try { await stopTunnel(config.configDir); } catch { /* may not exist — fine */ }

  // Generate config and start tunnel
  const wgConfig = generateWgConfig(device, server, gateway);
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
 * Deregisters the device from the Mullvad account before stopping the tunnel.
 */
export async function teardownMullvad(
  logger: Logger,
): Promise<void> {
  if (!activeConfig) return;

  // Deregister device before stopping tunnel
  if (activeDevice) {
    try {
      const token = await getAccessToken(activeConfig.accountNumber);
      await removeDevice(token, activeDevice.id);
      logger.info('Mullvad device deregistered');
    } catch {
      logger.warn('Failed to deregister Mullvad device (non-fatal)');
    }
  }

  await stopTunnel(activeConfig.configDir);
  logger.info('WireGuard tunnel stopped');

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

    // Resolve bypasses (always include api.mullvad.net)
    const allSwitchBypasses = ['api.mullvad.net', ...(bypassHosts ?? [])];
    const resolvedBypasses: Array<{ hostname: string; ips: string[] }> = [];
    for (const host of allSwitchBypasses) {
      const ips = await resolveBypassHost(host);
      if (ips.length > 0) resolvedBypasses.push({ hostname: host, ips });
    }

    // Find new relay
    const relays = await getRelayList();
    const { country, city, server } = findRelay(relays, location);

    // Start new tunnel
    const wgConfig = generateWgConfig(activeDevice, server, gateway);
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
