import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { isBlockedHostLiteral, safeResolveHost } from './url.js';
import { dialThroughProxy } from '../proxy/index.js';
import type { ProxyConfig } from '../proxy/types.js';

// Local SSRF-filtering forward proxy for ffmpeg / ffprobe and Chromium. Every CONNECT
// target and every HTTP absolute-URI request goes through safeResolveHost
// before the proxy opens an upstream socket — so ffmpeg can't reach a
// private IP even if the user-supplied URL redirects, even if the
// manifest's segment URIs point at internal hosts, and even if a DNS
// server is actively trying to rebind between our validation and ffmpeg's
// connect. The proxy ONLY accepts connections from loopback so nothing
// else on the network can use it as an open relay.
//
// Why a proxy instead of pinning the IP into the URL: HLS/DASH manifests
// reference additional URLs (sub-manifests, segment lists, per-segment
// URIs) that ffmpeg fetches itself. We can't pre-resolve all of those —
// we don't know them until ffmpeg parses the manifest. Funnelling every
// ffmpeg HTTP(S) egress through a single choke-point is the only way
// to cover that surface.
//
// With an upstream proxy (PROXY_URL) configured, this proxy chains to it:
// targets are validated by their literal host only (the upstream resolves
// names — resolving here too would leak every hostname to this host's DNS
// resolver), then tunnelled through the upstream. ffmpeg can't be pointed
// at the upstream directly: it only honours http:// proxies, so a SOCKS or
// https:// PROXY_URL used to be silently ignored and ffmpeg connected
// straight out from the host's real IP.

const IDLE_SOCKET_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — generous for slow CDNs
const CONNECT_UPSTREAM_TIMEOUT_MS = 15 * 1000;

export class SsrfProxy {
  private server: http.Server | null = null;
  private port: number | null = null;
  private activeSockets = new Set<Duplex>();

  constructor(private readonly upstream?: ProxyConfig) {}

  /**
   * Validate host and open a TCP connection to host:port — pinned to the
   * validated address when connecting directly, or tunnelled through the
   * upstream proxy. Returns null if the target is blocked.
   */
  private async openUpstream(host: string, port: number): Promise<net.Socket | null> {
    if (this.upstream) {
      if (isBlockedHostLiteral(host)) return null;
      const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
      return dialThroughProxy(this.upstream, bare, port);
    }
    const resolved = await safeResolveHost(host);
    if (!resolved) return null;
    const sock = net.createConnection({ host: resolved.address, port, family: resolved.family });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('connect timeout'));
      }, CONNECT_UPSTREAM_TIMEOUT_MS);
      sock.once('connect', () => { clearTimeout(timer); resolve(); });
      sock.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    return sock;
  }

  /**
   * Start the proxy on a random loopback port. Resolves with the bound
   * port number so callers can set `http_proxy=http://127.0.0.1:<port>`
   * on subprocesses.
   */
  async start(): Promise<number> {
    const server = http.createServer();

    server.on('request', (req, res) => {
      // Absolute-URI request = proxy-mode HTTP (fired by ffmpeg with
      // `-http_proxy` for http:// URLs). https:// never arrives here —
      // TLS requests come via CONNECT.
      this.handleHttp(req, res).catch(() => {
        try { res.writeHead(502); res.end(); } catch { /* already sent */ }
      });
    });

    server.on('connect', (req, clientSocket, head) => {
      // Runtime type is always net.Socket for CONNECT — the Duplex typing
      // on the event is a documentation artifact. Cast so we can use
      // setTimeout / 'timeout' events without fighting the compiler.
      const sock = clientSocket as net.Socket;
      this.handleConnect(req, sock, head).catch(() => {
        try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* already closed */ }
      });
    });

    // Malformed client request — just drop the connection rather than
    // leaking a stack trace.
    server.on('clientError', (_err, socket) => {
      try { socket.destroy(); } catch { /* already gone */ }
    });

    this.server = server;
    return new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      // Loopback-only bind. An ffmpeg running in the same container/host
      // reaches us; anything else on the LAN can't use us as an open
      // SSRF-bypass relay.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('SsrfProxy failed to bind'));
        }
      });
    });
  }

  /** Proxy URL in the form ffmpeg expects for `http_proxy` / `https_proxy`. */
  url(): string {
    if (this.port === null) throw new Error('SsrfProxy not started');
    return `http://127.0.0.1:${this.port}`;
  }

  /** Shut down the listener and forcibly close any in-flight sockets so
   *  a stuck upstream doesn't keep the process alive past ffmpeg exit. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const sock of this.activeSockets) {
      try { sock.destroy(); } catch { /* already dead */ }
    }
    this.activeSockets.clear();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    this.activeSockets.add(clientSocket);
    clientSocket.on('close', () => this.activeSockets.delete(clientSocket));

    const target = req.url ?? '';
    const lastColon = target.lastIndexOf(':');
    if (lastColon <= 0) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const host = target.slice(0, lastColon);
    const port = parseInt(target.slice(lastColon + 1), 10);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    let upstream: net.Socket | null;
    try {
      upstream = await this.openUpstream(host, port);
    } catch {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* already closed */ }
      return;
    }
    if (!upstream) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    this.activeSockets.add(upstream);
    upstream.on('close', () => this.activeSockets.delete(upstream));

    upstream.setTimeout(IDLE_SOCKET_TIMEOUT_MS);
    clientSocket.setTimeout(IDLE_SOCKET_TIMEOUT_MS);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    const closeBoth = () => {
      try { upstream.destroy(); } catch { /* already gone */ }
      try { clientSocket.destroy(); } catch { /* already gone */ }
    };
    upstream.on('error', closeBoth);
    upstream.on('timeout', closeBoth);
    clientSocket.on('error', closeBoth);
    clientSocket.on('timeout', closeBoth);
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!req.url) {
      res.writeHead(400); res.end(); return;
    }
    // In proxy mode the request line carries an absolute URI; req.url is
    // the full URL (e.g. `http://cdn.example/segment.ts`). Anything else
    // is a misconfigured client.
    let parsed: URL;
    try {
      parsed = new URL(req.url);
    } catch {
      res.writeHead(400); res.end('proxy: bad absolute URI'); return;
    }
    if (parsed.protocol !== 'http:') {
      // https:// should arrive via CONNECT, not absolute-URI; refuse so a
      // misconfigured client doesn't silently downgrade to plaintext.
      res.writeHead(400); res.end('proxy: use CONNECT for https'); return;
    }

    const port = parsed.port ? parseInt(parsed.port, 10) : 80;
    let socket: net.Socket | null;
    try {
      socket = await this.openUpstream(parsed.hostname, port);
    } catch {
      res.writeHead(502); res.end(); return;
    }
    if (!socket) {
      res.writeHead(403); res.end('proxy: target blocked'); return;
    }
    const upstreamSocket = socket;
    this.activeSockets.add(upstreamSocket);
    upstreamSocket.on('close', () => this.activeSockets.delete(upstreamSocket));

    const upstreamReq = http.request({
      host: parsed.hostname,
      port,
      path: (parsed.pathname || '/') + parsed.search,
      method: req.method,
      // Preserve the original Host header so the upstream's virtual hosting
      // still works even though we connect by IP.
      headers: { ...req.headers, host: parsed.host },
      // Use the socket we validated and opened; http.request must not
      // resolve or connect on its own.
      createConnection: () => upstreamSocket,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.setTimeout(IDLE_SOCKET_TIMEOUT_MS, () => {
      upstreamReq.destroy();
      try { res.writeHead(504); res.end(); } catch { /* already sent */ }
    });
    upstreamReq.on('error', () => {
      try { res.writeHead(502); res.end(); } catch { /* already sent */ }
    });

    req.pipe(upstreamReq);
  }
}
