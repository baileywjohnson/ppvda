import { stat } from 'node:fs/promises';

// Application-level VPN kill-switch. The OS handles routing, but nothing
// stops the app from issuing outbound requests if WireGuard drops mid-session.
// This module runs two periodic checks and exposes a boolean the request
// pre-handler gates on:
//
//   1. Interface presence — `stat /sys/class/net/<iface>`. Fast, local, cheap.
//      Catches `wg-quick down` and tunnel teardown by Mullvad/app.
//   2. Actual routing — GET https://am.i.mullvad.net/connected. Confirms
//      traffic really exits via Mullvad, not via a misconfigured bypass route.
//
// Both must pass within staleness thresholds or isVpnHealthy returns false.

interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
}

const LOCAL_CHECK_INTERVAL_MS = 5_000;
const REMOTE_CHECK_INTERVAL_MS = 60_000;
const REMOTE_CHECK_TIMEOUT_MS = 10_000;
// 3x the poll interval — a single missed tick still permits traffic, but a
// persistent failure (~15s local, ~3min remote) engages the kill-switch.
const LOCAL_STALE_MS = LOCAL_CHECK_INTERVAL_MS * 3;
const REMOTE_STALE_MS = REMOTE_CHECK_INTERVAL_MS * 3;

interface HealthState {
  interfaceOk: boolean;
  routingOk: boolean;
  interfaceLastCheck: number;
  routingLastCheck: number;
  interfaceError: string | null;
  routingError: string | null;
}

let state: HealthState | null = null;
let localTimer: NodeJS.Timeout | null = null;
let remoteTimer: NodeJS.Timeout | null = null;
let logger: Logger | null = null;
let interfaceName = 'wg0';

async function checkInterface(): Promise<void> {
  if (!state) return;
  try {
    await stat(`/sys/class/net/${interfaceName}`);
    if (!state.interfaceOk) {
      logger?.info({ interface: interfaceName }, 'VPN interface UP');
    }
    state.interfaceOk = true;
    state.interfaceError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (state.interfaceOk) {
      logger?.error({ interface: interfaceName, err: msg }, 'VPN interface DOWN — kill-switch engaged');
    }
    state.interfaceOk = false;
    state.interfaceError = msg;
  }
  state.interfaceLastCheck = Date.now();
}

async function checkRouting(): Promise<void> {
  if (!state) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch('https://am.i.mullvad.net/connected', { signal: controller.signal });
    const text = (await res.text()).toLowerCase();
    const ok = text.includes('you are connected');
    if (!state.routingOk && ok) {
      logger?.info('VPN routing through Mullvad confirmed');
    }
    if (state.routingOk && !ok) {
      logger?.error(
        { snippet: text.slice(0, 100) },
        'VPN NOT routing through Mullvad — kill-switch engaged',
      );
    }
    state.routingOk = ok;
    state.routingError = ok ? null : text.slice(0, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (state.routingOk) {
      logger?.error({ err: msg }, 'VPN routing check failed — kill-switch engaged');
    }
    state.routingOk = false;
    state.routingError = msg;
  } finally {
    clearTimeout(timeout);
    state.routingLastCheck = Date.now();
  }
}

/**
 * Begin the VPN kill-switch. Runs initial interface + routing checks
 * synchronously — if either fails, this throws and the app should refuse to
 * accept traffic. Once healthy, two background intervals keep the state fresh;
 * any persistent failure flips isVpnHealthy() to false until recovery.
 */
export async function startVpnHealthCheck(log: Logger, ifaceName = 'wg0'): Promise<void> {
  if (state) {
    throw new Error('VPN health check already running');
  }
  logger = log;
  interfaceName = ifaceName;
  state = {
    interfaceOk: false,
    routingOk: false,
    interfaceLastCheck: 0,
    routingLastCheck: 0,
    interfaceError: null,
    routingError: null,
  };

  // Initial checks — both must pass before we allow the app to bind.
  await checkInterface();
  await checkRouting();

  if (!state.interfaceOk || !state.routingOk) {
    const reason = `interface=${state.interfaceOk} routing=${state.routingOk} ifaceErr=${state.interfaceError ?? 'none'} routeErr=${state.routingError ?? 'none'}`;
    state = null;
    throw new Error(`VPN kill-switch: initial health check failed (${reason})`);
  }

  logger.info({ interface: interfaceName }, 'VPN kill-switch enabled and healthy');

  localTimer = setInterval(() => { void checkInterface(); }, LOCAL_CHECK_INTERVAL_MS);
  remoteTimer = setInterval(() => { void checkRouting(); }, REMOTE_CHECK_INTERVAL_MS);
  // Don't hold the event loop open just for health probes
  localTimer.unref();
  remoteTimer.unref();
}

export function stopVpnHealthCheck(): void {
  if (localTimer) { clearInterval(localTimer); localTimer = null; }
  if (remoteTimer) { clearInterval(remoteTimer); remoteTimer = null; }
  state = null;
  logger = null;
}

/**
 * Returns true when:
 *   - kill-switch is not enabled (bare deployment, no MULLVAD_ACCOUNT), or
 *   - both interface and routing checks are passing and fresh.
 * Returns false whenever a gated request should be blocked.
 */
export function isVpnHealthy(): boolean {
  if (!state) return true;
  const now = Date.now();
  const interfaceFresh = now - state.interfaceLastCheck < LOCAL_STALE_MS;
  const routingFresh = now - state.routingLastCheck < REMOTE_STALE_MS;
  return state.interfaceOk && state.routingOk && interfaceFresh && routingFresh;
}

export function isVpnKillSwitchEnabled(): boolean {
  return state !== null;
}

export function getVpnHealthDetails(): HealthState | null {
  return state ? { ...state } : null;
}
