export interface ProxyConfig {
  protocol: 'socks5' | 'socks4' | 'http' | 'https';
  host: string;
  port: number;
  username?: string;
  password?: string;
  raw: string; // original URL string
}
