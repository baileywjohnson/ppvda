import dns from 'node:dns/promises';
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
 * Bring up the WireGuard tunnel by handing the rendered config to
 * wg-supervisor. The supervisor writes `${configDir}/wg0.conf` (mode
 * 0600), runs `wg-quick up`, and overrides `/etc/resolv.conf` to the
 * Mullvad resolver. All privileged work happens on the supervisor side.
 */
export async function startTunnel(configDir: string, wgConfig: string): Promise<void> {
  try {
    await rpcBringup(configDir, wgConfig);
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
