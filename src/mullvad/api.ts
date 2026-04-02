import type { DeviceInfo, RelayCountry, RelayCity, RelayServer } from './types.js';
import type { WireGuardKeyPair } from './keys.js';

const API_BASE = 'https://api.mullvad.net';

/**
 * Get an access token for the Mullvad API.
 */
export async function getAccessToken(accountNumber: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_number: accountNumber }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mullvad auth failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Register a WireGuard device (key pair) with Mullvad.
 * Returns device info including assigned IP addresses.
 */
export async function createDevice(
  token: string,
  keys: WireGuardKeyPair,
): Promise<DeviceInfo> {
  const res = await fetch(`${API_BASE}/accounts/v1/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      pubkey: keys.publicKey,
      hijack_dns: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mullvad device creation failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    id: string;
    name: string;
    pubkey: string;
    ipv4_address: string;
    ipv6_address: string;
    created: string;
  };

  return {
    id: data.id,
    name: data.name,
    publicKey: data.pubkey,
    privateKey: keys.privateKey,
    ipv4Address: data.ipv4_address,
    ipv6Address: data.ipv6_address,
    createdAt: data.created,
  };
}

/**
 * Remove a device from the Mullvad account.
 */
export async function removeDevice(token: string, deviceId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/accounts/v1/devices/${deviceId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Mullvad device removal failed (${res.status}): ${body}`);
  }
}

/**
 * Fetch the full relay list from Mullvad.
 */
export async function getRelayList(): Promise<RelayCountry[]> {
  const res = await fetch(`${API_BASE}/app/v1/relays`);

  if (!res.ok) {
    throw new Error(`Failed to fetch Mullvad relay list (${res.status})`);
  }

  const data = (await res.json()) as {
    locations: Record<string, {
      country: string;
      city: string;
      latitude: number;
      longitude: number;
    }>;
    wireguard: {
      port_ranges: number[][];
      relays: Array<{
        hostname: string;
        location: string;
        active: boolean;
        owned: boolean;
        provider: string;
        weight: number;
        ipv4_addr_in: string;
        ipv6_addr_in: string;
        public_key: string;
      }>;
    };
  };

  // Group relays by country and city using the locations map
  const countryMap = new Map<string, RelayCountry>();

  for (const relay of data.wireguard.relays) {
    if (!relay.active) continue;

    const loc = data.locations[relay.location];
    if (!loc) continue;

    // Location code is "country-city" (e.g., "se-mma")
    const parts = relay.location.split('-');
    const countryCode = parts[0];
    const cityCode = relay.location; // full code like "se-mma"

    let country = countryMap.get(countryCode);
    if (!country) {
      country = {
        name: loc.country,
        code: countryCode,
        cities: [],
      };
      countryMap.set(countryCode, country);
    }

    let city = country.cities.find((c) => c.code === cityCode);
    if (!city) {
      city = {
        name: loc.city,
        code: cityCode,
        latitude: loc.latitude,
        longitude: loc.longitude,
        relays: [],
      };
      country.cities.push(city);
    }

    city.relays.push({
      hostname: relay.hostname,
      publicKey: relay.public_key,
      ipv4AddrIn: relay.ipv4_addr_in,
      ipv6AddrIn: relay.ipv6_addr_in,
      multihopPort: 0,
      weight: relay.weight,
      active: relay.active,
    });
  }

  return Array.from(countryMap.values());
}

/**
 * Find a relay server matching a location string.
 * Location format: "country_code" (e.g., "se") or "country_code-city_code" (e.g., "se-mma").
 */
export function findRelay(
  relays: RelayCountry[],
  location: string,
): { country: RelayCountry; city: RelayCity; server: RelayServer } {
  const parts = location.toLowerCase().split('-');
  const countryCode = parts[0];
  const cityCode = parts.length > 1 ? parts.slice(1).join('-') : undefined;

  const country = relays.find((c) => c.code === countryCode);
  if (!country) {
    const available = relays.map((c) => `${c.code} (${c.name})`).join(', ');
    throw new Error(`Country "${countryCode}" not found. Available: ${available}`);
  }

  let city: RelayCity;
  if (cityCode) {
    const found = country.cities.find((c) => c.code === cityCode);
    if (!found) {
      const available = country.cities.map((c) => `${c.code} (${c.name})`).join(', ');
      throw new Error(`City "${cityCode}" not found in ${country.name}. Available: ${available}`);
    }
    city = found;
  } else {
    // Pick the city with the most relays (likely best connectivity)
    city = country.cities.sort((a, b) => b.relays.length - a.relays.length)[0];
  }

  // Pick a relay weighted by the server's weight value
  const server = pickWeightedRelay(city.relays);

  return { country, city, server };
}

function pickWeightedRelay(relays: RelayServer[]): RelayServer {
  const totalWeight = relays.reduce((sum, r) => sum + r.weight, 0);
  let random = Math.random() * totalWeight;

  for (const relay of relays) {
    random -= relay.weight;
    if (random <= 0) return relay;
  }

  return relays[relays.length - 1];
}
