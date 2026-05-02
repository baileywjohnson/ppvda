import dns from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import type { DeviceInfo, RelayServer } from './types.js';
import { rpcAddRoutes, rpcBringup, rpcGateway, rpcTeardown } from './supervisor-rpc.js';

// This module used to execFile('wg-quick'/'ip'/'writeFile') directly from
// the Node process, which meant the whole process needed CAP_NET_ADMIN and
// root — and therefore so did every Playwright-spawned Chromium, which
// can't run its user-namespace sandbox as root. Now every privileged
// action is a single-line RPC to wg-supervisor, which is the only part of
// the container that runs as root. The main Node process runs as the
// unprivileged `ppvda` user and Chromium's sandbox works.
//
// The public surface of this file is unchanged — callers don't see the
// socket — so src/mullvad/index.ts and the VPN admin routes keep working.

const WG_INTERFACE = 'wg0';
const WG_PORT = 51820;

/**
 * Bring up the WireGuard tunnel by handing the typed parameters to
 * wg-supervisor. The supervisor renders the config text itself from
 * these values, writes `${configDir}/wg0.conf` (mode 0600), runs
 * `wg-quick up`, and overrides `/etc/resolv.conf` to the Mullvad
 * resolver. All privileged work happens on the supervisor side.
 *
 * Why typed fields and not a rendered string: `wg-quick` honors
 * `PostUp`/`PreUp`/`PostDown`/`PreDown` lines as `/bin/sh -c …`. If we
 * passed a free-form config text, any compromise of this Node process
 * could escalate to root via injected hook directives. The supervisor
 * regex-validates each field and reconstructs the config from a fixed
 * template — see wg-supervisor/main.go:doBringup.
 *
 * Routing context (rendered identically in the supervisor):
 *   - `Table = off` — wg-quick skips fwmark-based policy routing, which
 *     would need the `net.ipv4.conf.all.src_valid_mark` sysctl (a
 *     privileged global kernel knob). PostUp/PreDown manage routes.
 *   - PostUp adds an explicit route for the relay's IP via the
 *     original default gateway so the WireGuard UDP packets reach it
 *     instead of looping through the tunnel, then replaces the default
 *     route with wg0.
 *   - PreDown restores the original default route. Without a symmetric
 *     restore, country-switch / teardown leaves the container with no
 *     default route, breaking the next bring-up's relay route lookup
 *     on some kernels. `ip route replace` is idempotent.
 */
export async function startTunnel(
  configDir: string,
  device: DeviceInfo,
  server: RelayServer,
  gateway: string | null,
): Promise<void> {
  const gw = gateway ?? '172.17.0.1';
  try {
    await rpcBringup({
      configDir,
      privateKey: device.privateKey,
      address: device.ipv4Address,
      dns: '10.64.0.1',
      peerPublicKey: server.publicKey,
      peerEndpoint: `${server.ipv4AddrIn}:${WG_PORT}`,
      peerAllowedIPs: '0.0.0.0/0',
      relayIP: server.ipv4AddrIn,
      gateway: gw,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start WireGuard tunnel: ${msg}`);
  }
}

/**
 * Tear down the WireGuard tunnel and restore the embedded Docker DNS
 * resolver. Best-effort — the supervisor ignores "tunnel not up" errors
 * so repeated teardowns are safe.
 */
export async function stopTunnel(configDir: string): Promise<void> {
  try {
    await rpcTeardown(configDir);
  } catch {
    // Tunnel may not be up or supervisor may be mid-restart — ignore
  }
}

/**
 * Get the default gateway IP before the tunnel overrides it. Delegated
 * to the supervisor because `ip route show default` lives in the same
 * privileged toolbox, even though this specific read doesn't strictly
 * need privileges.
 */
export async function getDefaultGateway(): Promise<string | null> {
  try {
    return await rpcGateway();
  } catch {
    return null;
  }
}

/**
 * Resolve a hostname to IPs and store the mappings.
 * Must be called BEFORE the tunnel starts (while Docker's DNS is still
 * available). Runs unprivileged in the Node process — just a DNS lookup.
 */
export async function resolveBypassHost(hostname: string): Promise<string[]> {
  // If it's already a valid IPv4 literal, return it directly. Use Node's
  // net.isIPv4 rather than a permissive regex so out-of-range octets are
  // rejected before they reach the supervisor's `ip route add` argv.
  if (isIPv4(hostname)) {
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
 * Add route exceptions so traffic to specific IPs bypasses the WireGuard
 * tunnel, and write /etc/hosts entries so the hostnames resolve after
 * VPN DNS takes over. Both halves happen inside the supervisor — `ip
 * route add` needs CAP_NET_ADMIN and /etc/hosts writes need root. Input
 * validation (hostname charset, IPv4 shape) is re-checked on the
 * supervisor side too so a bug here can't smuggle malformed values into
 * privileged argv.
 */
export async function addRouteExceptions(
  hosts: Array<{ hostname: string; ips: string[] }>,
  gateway: string,
): Promise<void> {
  try {
    await rpcAddRoutes(gateway, hosts);
  } catch {
    // Non-fatal — best-effort; a failure here just means hostname lookups
    // go through VPN DNS instead of resolving locally.
  }
}
