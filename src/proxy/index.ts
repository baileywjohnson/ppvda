import net from 'node:net';
import tls from 'node:tls';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Agent } from 'node:http';
import type { ProxyConfig } from './types.js';

export type { ProxyConfig } from './types.js';

const PROXY_CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;

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

/**
 * Node http(s) agent that tunnels through the configured proxy. SOCKS
 * agents use the remote-resolving variants (socks5h / socks4a): with plain
 * socks5:// the agent resolves the target locally, sending every hostname
 * to the host's DNS resolver even though the connection itself is proxied.
 */
export function getHttpAgent(config: ProxyConfig): Agent {
  if (config.protocol === 'socks5' || config.protocol === 'socks4') {
    const url = new URL(config.raw);
    url.protocol = config.protocol === 'socks5' ? 'socks5h:' : 'socks4a:';
    return new SocksProxyAgent(url.toString());
  }
  return new HttpsProxyAgent(config.raw);
}

/**
 * Open a TCP tunnel to host:port through the configured upstream proxy.
 * The target hostname is sent to the proxy unresolved, so name resolution
 * happens on the proxy's side, never on this host.
 */
export async function dialThroughProxy(config: ProxyConfig, host: string, port: number): Promise<net.Socket> {
  const username = config.username ? decodeURIComponent(config.username) : undefined;
  const password = config.password ? decodeURIComponent(config.password) : undefined;

  if (config.protocol === 'socks5' || config.protocol === 'socks4') {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: config.host,
        port: config.port,
        type: config.protocol === 'socks5' ? 5 : 4,
        ...(username ? { userId: username } : {}),
        ...(password ? { password } : {}),
      },
      command: 'connect',
      destination: { host, port },
      timeout: PROXY_CONNECT_TIMEOUT_MS,
    });
    return socket;
  }

  return httpConnect(config, host, port, username, password);
}

async function httpConnect(
  config: ProxyConfig,
  host: string,
  port: number,
  username: string | undefined,
  password: string | undefined,
): Promise<net.Socket> {
  const socket: net.Socket = config.protocol === 'https'
    ? tls.connect({ host: config.host, port: config.port, servername: net.isIP(config.host) ? undefined : config.host })
    : net.connect({ host: config.host, port: config.port });

  return new Promise<net.Socket>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('proxy CONNECT timed out')), PROXY_CONNECT_TIMEOUT_MS);
    const fail = (err: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > MAX_CONNECT_RESPONSE_BYTES) fail(new Error('proxy CONNECT response too large'));
        return;
      }
      socket.off('data', onData);
      socket.off('error', fail);
      clearTimeout(timer);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'));
      if (!status || status[1] !== '200') {
        socket.destroy();
        reject(new Error(`proxy CONNECT refused (${status?.[1] ?? 'bad response'})`));
        return;
      }
      const rest = buf.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.once(config.protocol === 'https' ? 'secureConnect' : 'connect', () => {
      const target = net.isIPv6(host) ? `[${host}]` : host;
      const auth = username !== undefined
        ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${target}:${port} HTTP/1.1\r\nHost: ${target}:${port}\r\n${auth}\r\n`);
    });
    socket.on('data', onData);
    socket.on('error', fail);
  });
}
