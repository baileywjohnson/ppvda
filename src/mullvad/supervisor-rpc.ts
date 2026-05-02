import { createConnection, type Socket } from 'node:net';

// RPC client for wg-supervisor — the privileged Go helper that owns the
// operations requiring CAP_NET_ADMIN (wg-quick, ip route, /etc/hosts edits,
// /etc/resolv.conf override). See wg-supervisor/main.go for the server side.
//
// Protocol: one length-prefixed JSON frame per direction, connection closes
// after the response. Big-endian uint32 length, payload up to 64 KiB.

const SOCKET_PATH = process.env.WG_SUPERVISOR_SOCKET ?? '/run/ppvda/wg.sock';
const RPC_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 64 * 1024;

export interface BringupRequest {
  op: 'BRINGUP';
  configDir: string;
  privateKey: string;
  address: string;
  dns: string;
  peerPublicKey: string;
  peerEndpoint: string;
  peerAllowedIPs: string;
  relayIP: string;
  gateway: string;
}

export type BringupArgs = Omit<BringupRequest, 'op'>;

export interface TeardownRequest {
  op: 'TEARDOWN';
  configDir: string;
}

export interface AddRoutesRequest {
  op: 'ADD_ROUTES';
  gateway: string;
  hosts: Array<{ hostname: string; ips: string[] }>;
}

export interface GatewayRequest {
  op: 'GATEWAY';
}

type Request = BringupRequest | TeardownRequest | AddRoutesRequest | GatewayRequest;

interface RawResponse {
  ok?: boolean;
  error?: string;
  data?: unknown;
}

// call opens a connection, sends one request frame, reads one response
// frame, closes the connection. A fresh socket per call keeps state
// management trivial and matches the supervisor's one-shot handler model.
async function call(req: Request): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(req), 'utf-8');
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`wg-supervisor request too large: ${payload.length} bytes`);
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);

  return new Promise<unknown>((resolve, reject) => {
    const sock = createConnection(SOCKET_PATH);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`wg-supervisor RPC timed out after ${RPC_TIMEOUT_MS}ms (op=${req.op})`));
    }, RPC_TIMEOUT_MS);

    sock.once('connect', () => {
      sock.write(lenBuf);
      sock.write(payload);
    });

    sock.on('data', (buf: Buffer) => {
      chunks.push(buf);
      // Once we've got enough bytes, try to decode. Response fits in one
      // frame so we only need to parse the first N bytes.
      const all = Buffer.concat(chunks);
      if (all.length < 4) return;
      const n = all.readUInt32BE(0);
      if (n === 0 || n > MAX_FRAME_BYTES) {
        clearTimeout(timer);
        sock.destroy();
        reject(new Error(`wg-supervisor bad frame length: ${n}`));
        return;
      }
      if (all.length < 4 + n) return;
      clearTimeout(timer);
      sock.end();
      try {
        const resp = JSON.parse(all.subarray(4, 4 + n).toString('utf-8')) as RawResponse;
        if (resp.ok) {
          resolve(resp.data ?? null);
        } else {
          reject(new Error(resp.error ?? 'wg-supervisor returned failure without message'));
        }
      } catch (err) {
        reject(new Error(`wg-supervisor response parse: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`wg-supervisor connect ${SOCKET_PATH}: ${err.message}`));
    });

    // Peer-closed-without-response guard. If the supervisor drops the
    // connection after reading without writing back, surface that rather
    // than hang until RPC_TIMEOUT_MS.
    sock.on('close', () => {
      clearTimeout(timer);
      if (chunks.length === 0) {
        reject(new Error('wg-supervisor closed connection without response'));
      }
    });
  });
}

export async function rpcBringup(args: BringupArgs): Promise<void> {
  await call({ op: 'BRINGUP', ...args });
}

export async function rpcTeardown(configDir: string): Promise<void> {
  await call({ op: 'TEARDOWN', configDir });
}

export async function rpcAddRoutes(
  gateway: string,
  hosts: Array<{ hostname: string; ips: string[] }>,
): Promise<void> {
  await call({ op: 'ADD_ROUTES', gateway, hosts });
}

export async function rpcGateway(): Promise<string | null> {
  const data = await call({ op: 'GATEWAY' }) as { gateway?: string } | null;
  return data?.gateway ?? null;
}
