import type { ProxyConfig } from '../proxy/types.js';

/**
 * In-memory VPN permission store.
 * Controls the server-wide VPN default and per-user toggle permissions.
 * Resets on server restart — no persistent storage for privacy.
 */
export class VpnPermissionStore {
  private vpnDefault: 'on' | 'off' = 'on';
  private toggleAllowed = new Set<string>();

  getDefault(): 'on' | 'off' {
    return this.vpnDefault;
  }

  setDefault(value: 'on' | 'off'): void {
    this.vpnDefault = value;
  }

  grantToggle(userId: string): void {
    this.toggleAllowed.add(userId);
  }

  revokeToggle(userId: string): void {
    this.toggleAllowed.delete(userId);
  }

  canToggle(userId: string): boolean {
    return this.toggleAllowed.has(userId);
  }

  listToggleUserIds(): string[] {
    return Array.from(this.toggleAllowed);
  }

  removeUser(userId: string): void {
    this.toggleAllowed.delete(userId);
  }
}

/**
 * Resolve whether to use the VPN proxy for a given request.
 * Enforces the server-wide default and per-user toggle permissions.
 */
export function resolveProxy(
  useVpn: boolean | undefined,
  userId: string,
  isAdmin: boolean,
  vpnPermissions: VpnPermissionStore,
  proxyConfig: ProxyConfig | undefined,
): ProxyConfig | undefined {
  if (!proxyConfig) return undefined;

  const vpnDefault = vpnPermissions.getDefault();
  const canToggle = isAdmin || vpnPermissions.canToggle(userId);

  if (!canToggle) {
    // User cannot override — use server default
    return vpnDefault === 'on' ? proxyConfig : undefined;
  }

  // User can toggle — honor their explicit choice, fall back to default
  if (useVpn === true) return proxyConfig;
  if (useVpn === false) return undefined;
  return vpnDefault === 'on' ? proxyConfig : undefined;
}
