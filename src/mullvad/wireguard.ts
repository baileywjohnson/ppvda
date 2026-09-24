import type { DeviceInfo, RelayServer } from './types.js';
import { rpcAddRoutes, rpcBringup, rpcGateway, rpcTeardown, type AddRoutesResult } from './supervisor-rpc.js';

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
 *   - PreDown replaces the default route with `unreachable` rather than
 *     restoring the real gateway, and the supervisor's kill switch blocks
 *     everything but the tunnel, the relay handshake and the bypass hosts
 *     either way. The relay route's next hop is the gateway the supervisor
 *     captured at boot; `gateway` here is only its fallback.
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
 * Route the named bypass hosts around the WireGuard tunnel. The supervisor
 * only accepts hostnames from the allowlist the entrypoint pinned at
 * startup (`VPN_BYPASS_HOSTS` + api.mullvad.net), resolves them itself,
 * adds the /32 routes, kill-switch exceptions and /etc/hosts entries, and
 * returns what it routed. Node no longer resolves or supplies addresses:
 * any process running as the ppvda uid can reach the supervisor, so
 * caller-supplied IPs were a hole in the kill switch.
 *
 * Resolution uses Docker's DNS before the first tunnel comes up and
 * Mullvad's resolver while it is up; with the tunnel down after that, only
 * hosts pinned earlier can be re-routed. Call it before BRINGUP at startup
 * and before TEARDOWN on a country switch.
 */
export async function addRouteExceptions(hostnames: string[]): Promise<AddRoutesResult> {
  return rpcAddRoutes(hostnames);
}
