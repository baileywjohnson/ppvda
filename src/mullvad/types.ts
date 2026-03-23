export interface MullvadConfig {
  accountNumber: string;
  location: string; // e.g. "se-mma", "us-nyc", "de-ber"
  configDir: string; // where to persist WireGuard config + device info
}

export interface DeviceInfo {
  id: string;
  name: string;
  publicKey: string;
  privateKey: string;
  ipv4Address: string;
  ipv6Address: string;
  createdAt: string;
}

export interface RelayServer {
  hostname: string;
  publicKey: string;
  ipv4AddrIn: string;
  ipv6AddrIn: string;
  multihopPort: number;
  weight: number;
  active: boolean;
}

export interface RelayCity {
  name: string;
  code: string;
  latitude: number;
  longitude: number;
  relays: RelayServer[];
}

export interface RelayCountry {
  name: string;
  code: string;
  cities: RelayCity[];
}
