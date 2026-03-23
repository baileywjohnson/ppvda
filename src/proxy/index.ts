import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Agent } from 'node:http';
import type { ProxyConfig } from './types.js';

export type { ProxyConfig } from './types.js';

export function parseProxyUrl(url: string): ProxyConfig {
  const parsed = new URL(url);
  const protocol = parsed.protocol.replace(':', '') as ProxyConfig['protocol'];

  if (!['socks5', 'socks4', 'http', 'https'].includes(protocol)) {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }

  return {
    protocol,
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || (protocol.startsWith('socks') ? 1080 : 8080),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    raw: url,
  };
}

export function getPlaywrightProxy(config: ProxyConfig) {
  return {
    server: `${config.protocol}://${config.host}:${config.port}`,
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
  };
}

export function getHttpAgent(config: ProxyConfig): Agent {
  if (config.protocol === 'socks5' || config.protocol === 'socks4') {
    return new SocksProxyAgent(config.raw);
  }
  return new HttpsProxyAgent(config.raw);
}

export function getFfmpegEnv(config: ProxyConfig): Record<string, string> {
  // ffmpeg respects http_proxy for HTTP-based proxies.
  // For SOCKS, we use ALL_PROXY which some builds of ffmpeg/libcurl respect.
  const url = `${config.protocol}://${config.host}:${config.port}`;
  return {
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
  };
}
