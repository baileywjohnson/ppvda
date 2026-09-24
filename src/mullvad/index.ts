import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generateWireGuardKeys } from './keys.js';
import { getAccessToken, createDevice, removeDevice, listDevices, getRelayList, findRelay } from './api.js';
import {
  startTunnel,
  stopTunnel,
  getDefaultGateway,
  addRouteExceptions,
} from './wireguard.js';
import type { MullvadConfig, DeviceInfo } from './types.js';
import { setVpnBypassIPs } from '../utils/url.js';

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

// Must match the entrypoint, which pins the same list in the supervisor.
const MULLVAD_API_HOST = 'api.mullvad.net';

// Devices this instance registered and has not yet seen removed, as
// { id, pubkey }. Kept next to the database (a persistent, ppvda-owned
// volume) so a crash, a failed health check or a restart loop can't leak
// devices: the next start removes them. Holds no private key — a fresh key
// pair is generated on every start. It is also the only thing that lets
// PPVDA tell its own devices apart from the operator's phone or laptop on
// the same account; nothing else is ever removed.
interface OwnDevice { id: string; pubkey: string }
const OWN_DEVICES_FILE = join(dirname(process.env.DB_PATH ?? './data/ppvda.db'), 'mullvad-devices.json');

async function loadOwnDevices(): Promise<OwnDevice[]> {
  try {
    const parsed = JSON.parse(await readFile(OWN_DEVICES_FILE, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is OwnDevice =>
      typeof d === 'object' && d !== null
      && typeof (d as OwnDevice).id === 'string' && typeof (d as OwnDevice).pubkey === 'string');
  } catch {
    return [];
  }
}

async function saveOwnDevices(devices: OwnDevice[]): Promise<void> {
  const tmp = `${OWN_DEVICES_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(devices), { mode: 0o600 });
  await rename(tmp, OWN_DEVICES_FILE);
}

async function forgetOwnDevice(id: string): Promise<void> {
  const devices = await loadOwnDevices();
  await saveOwnDevices(devices.filter((d) => d.id !== id));
}

/**
 * Remove devices a previous run of this instance registered but never
 * deregistered (crash, failed startup). A device is only removed if the
 * account still lists it with the exact public key we registered.
 */
async function removeStaleOwnDevices(token: string, logger: Logger): Promise<void> {
  const own = await loadOwnDevices();
  if (own.length === 0) return;
  const listed = await listDevices(token);
  const remaining: OwnDevice[] = [];
  let removed = 0;
  for (const dev of own) {
    const match = listed.find((d) => d.id === dev.id && d.pubkey === dev.pubkey);
    if (!match) continue; // already gone
    try {
      await removeDevice(token, dev.id);
      removed++;
    } catch {
      remaining.push(dev);
    }
  }
  await saveOwnDevices(remaining);
  if (removed > 0) logger.info({ removed }, 'Removed stale Mullvad devices left by a previous run');
  if (remaining.length > 0) logger.warn({ remaining: remaining.length }, 'Could not remove some stale Mullvad devices; will retry next start');
}

/** Deregister `device` and drop it from the own-devices file. Best-effort. */
async function deregisterDevice(accountNumber: string, device: DeviceInfo, logger: Logger): Promise<boolean> {
  try {
    const token = await getAccessToken(accountNumber);
    await removeDevice(token, device.id);
    await forgetOwnDevice(device.id);
    return true;
  } catch {
    logger.warn('Failed to deregister Mullvad device; it will be removed on the next start');
    return false;
  }
}

/**
 * Ask the supervisor to route the bypass hosts around the tunnel, and
 * register the addresses it routed as off-limits for extraction. Non-fatal:
 * without a bypass, that host is reached through the tunnel instead.
 */
async function routeBypasses(bypassHosts: string[] | undefined, logger: Logger): Promise<void> {
  const hostnames = [...new Set([MULLVAD_API_HOST, ...(bypassHosts ?? [])])];
  try {
    const { hosts, errors } = await addRouteExceptions(hostnames);
    for (const h of hosts) logger.info({ host: h.hostname, ips: h.ips }, 'VPN bypass host routed');
    for (const e of errors) logger.warn({ err: e }, 'VPN bypass host not routed');
    registerBypasses(hosts);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not add VPN bypass routes');
  }
}

/**
 * Set up a Mullvad VPN connection via WireGuard.
 *
 * Flow:
 * 1. Remove devices a previous run of this instance leaked
 * 2. Fetch the relay list and pick a server for the requested location
 * 3. Route the bypass hosts (supervisor resolves them via Docker DNS)
 * 4. Generate fresh WireGuard keys and register a device with Mullvad
 * 5. Bring up the tunnel — on failure, deregister the device again
 *
 * Everything that can fail on bad configuration happens before the device
 * is registered, so a misconfigured container restarting under
 * `restart: unless-stopped` doesn't add a device per attempt.
 */
export async function setupMullvad(
  config: MullvadConfig,
  logger: Logger,
  bypassHosts?: string[],
): Promise<void> {
  activeConfig = config;

  const token = await getAccessToken(config.accountNumber);
  await removeStaleOwnDevices(token, logger);

  // Fetch relay list and find matching server (validates MULLVAD_LOCATION)
  logger.info('Finding Mullvad relay...');
  const relays = await getRelayList();
  const { server } = findRelay(relays, config.location);

  // Capture default gateway BEFORE tunnel overrides routing
  const gateway = await getDefaultGateway();

  // Route bypass hosts BEFORE the tunnel starts: the supervisor resolves
  // them itself, and until the first BRINGUP Docker's DNS is still usable.
  // api.mullvad.net is always included so device management keeps working
  // after the tunnel replaces the default route.
  await routeBypasses(bypassHosts, logger);

  logger.info('Registering new Mullvad device...');
  const keys = generateWireGuardKeys();
  let device: DeviceInfo;
  try {
    device = await createDevice(token, keys);
  } catch (err) {
    // Never evict a device this instance didn't create — it may be the
    // operator's phone. Our own leftovers were already removed above.
    if (err instanceof Error && err.message.includes('MAX_DEVICES_REACHED')) {
      throw new Error(
        'Mullvad account has reached its device limit. Remove an unused device in your Mullvad account and restart PPVDA.',
      );
    }
    throw err;
  }
  activeDevice = device;
  try {
    const own = await loadOwnDevices();
    await saveOwnDevices([...own.filter((d) => d.id !== device.id), { id: device.id, pubkey: device.publicKey }]);
  } catch {
    logger.warn('Could not record the Mullvad device; it will not be cleaned up automatically if startup fails');
  }
  logger.info('Mullvad device registered');

  try {
    // Ensure no stale tunnel from a previous crash/SIGKILL before starting
    await stopTunnel(config.configDir);

    // Start the tunnel — the supervisor renders the config from typed fields.
    await startTunnel(config.configDir, device, server, gateway);
  } catch (err) {
    await deregisterDevice(config.accountNumber, device, logger);
    activeDevice = null;
    throw err;
  }

  logger.info('WireGuard tunnel is up — all traffic routed through Mullvad');
}

/**
 * Bypass IPs are routed around the tunnel for *every* connection, not just
 * the Mullvad API / Darkreel client that needs them. Extraction egress must
 * never target them: a page on a CDN edge IP shared with the Darkreel host
 * would otherwise be fetched outside the tunnel, exposing the real IP.
 */
function registerBypasses(bypasses: Array<{ ips: string[] }>): void {
  setVpnBypassIPs(bypasses.flatMap((b) => b.ips));
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
    if (await deregisterDevice(activeConfig.accountNumber, activeDevice, logger)) {
      logger.info('Mullvad device deregistered');
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
    // Do everything that needs the network BEFORE tearing the tunnel down:
    // re-route the bypasses (hosts pinned at startup are reused; any that
    // failed then are resolved now via Mullvad DNS, which only works while
    // the tunnel is up), fetch the relay list and validate the location.
    // Previously this happened after teardown, and a bad location or API
    // failure left no tunnel at all.
    await routeBypasses(bypassHosts, logger);
    const relays = await getRelayList();
    const { country, city, server } = findRelay(relays, location);

    // The supervisor returns the gateway it captured at boot, so this works
    // even while the tunnel is up.
    const gateway = await getDefaultGateway();

    // Tear down existing tunnel. The supervisor's kill switch keeps all
    // non-tunnel egress blocked until the new tunnel is up.
    await stopTunnel(activeConfig.configDir);
    logger.info('Tunnel stopped for country switch');

    // Start new tunnel
    await startTunnel(activeConfig.configDir, activeDevice, server, gateway);

    // Update stored location
    activeConfig = { ...activeConfig, location };

    logger.info({ country: country.name, city: city.name }, 'Switched VPN country');

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
