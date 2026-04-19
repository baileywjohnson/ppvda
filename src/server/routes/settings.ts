import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { encryptJSON, decryptJSON, zeroBuffer } from '../../crypto/index.js';
import { isPrivateUrl } from '../../utils/url.js';

export interface DarkreelCreds {
  server: string;
  username: string;
  password: string;
}

interface SettingsRouteOpts {
  db: DB;
  sessions: SessionStore;
  preHandler: preHandlerHookHandler;
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRouteOpts) {
  const { db, sessions } = opts;

  // Check if user has Darkreel credentials configured
  app.get(
    '/settings/darkreel',
    { preHandler: [opts.preHandler] },
    async (request) => {
      const userId = (request as any).user.sub;
      return { success: true, data: { configured: db.hasDarkreelCreds(userId) } };
    },
  );

  // Save/update Darkreel credentials
  app.put<{ Body: { server: string; username: string; password: string } }>(
    '/settings/darkreel',
    {
      preHandler: [opts.preHandler],
      schema: {
        body: {
          type: 'object',
          required: ['server', 'username', 'password'],
          properties: {
            server: { type: 'string', minLength: 1 },
            username: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      const { server, username, password } = request.body;

      // SSRF defense: block private/internal addresses for non-admins. The
      // stored URL is used by the job pipeline's connection-test fetch, so
      // a non-admin who could point it at 127.0.0.1 / 192.168.*.* / a
      // .internal name would be pivoting PPVDA's network position inside the
      // deployment. Admins already have network-adjacent capability (shell
      // access, config edits, etc.), so letting them deliberately target a
      // same-host or same-LAN Darkreel is a legitimate self-hosted pattern.
      //
      // isPrivateUrl catches loopback, RFC1918, link-local, IPv6 ULA, and
      // anything under the .internal / .local reserved suffixes — covering
      // the older explicit Docker-internal hostname list as a subset.
      const isAdmin = (request as any).user.isAdmin;
      if (await isPrivateUrl(server)) {
        if (!isAdmin) {
          reply.status(400).send({ success: false, error: 'Private/internal server URLs are not allowed' });
          return;
        }
        // Admin override — record that it happened so operational review
        // can spot accidental/malicious private-URL saves after the fact.
        const hostname = (() => { try { return new URL(server).hostname.toLowerCase(); } catch { return ''; } })();
        request.log.info({ userId, hostname }, 'Admin saved Darkreel creds targeting a private/internal URL');
      }

      // Test connection before saving
      try {
        const testRes = await fetch(`${server.replace(/\/+$/, '')}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
          signal: AbortSignal.timeout(10000),
        });
        if (!testRes.ok) {
          const text = await testRes.text().catch(() => '');
          reply.status(400).send({ success: false, error: 'Darkreel login failed — check your credentials and server URL' });
          return;
        }
      } catch {
        reply.status(400).send({ success: false, error: 'Could not connect to Darkreel server — check the URL' });
        return;
      }

      const masterKey = sessions.getKeyForUser(userId);
      if (!masterKey) {
        reply.status(401).send({ success: false, error: 'Session expired, please re-login' });
        return;
      }

      try {
        const userIdBytes = Buffer.from(userId, 'utf-8');
        const creds: DarkreelCreds = { server, username, password };
        const { ciphertext, nonce } = encryptJSON(creds, masterKey, userIdBytes);

        db.saveDarkreelCreds(userId, ciphertext, nonce);
        reply.send({ success: true });
      } finally {
        zeroBuffer(masterKey);
      }
    },
  );

  // Delete Darkreel credentials
  app.delete(
    '/settings/darkreel',
    { preHandler: [opts.preHandler] },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      db.deleteDarkreelCreds(userId);
      reply.send({ success: true });
    },
  );
}

/**
 * Decrypt a user's Darkreel credentials. Returns null if not configured or session expired.
 */
export function getUserDarkreelCreds(db: DB, sessions: SessionStore, userId: string): DarkreelCreds | null {
  const masterKey = sessions.getKeyForUser(userId);
  if (!masterKey) return null;

  const row = db.getDarkreelCreds(userId);
  if (!row) {
    zeroBuffer(masterKey);
    return null;
  }

  try {
    const userIdBytes = Buffer.from(userId, 'utf-8');
    // Try with AAD first (current format)
    try {
      return decryptJSON<DarkreelCreds>(row.encrypted_data, row.nonce, masterKey, userIdBytes);
    } catch {
      // Fall back to without AAD (legacy) and transparently re-encrypt with AAD
      const result = decryptJSON<DarkreelCreds>(row.encrypted_data, row.nonce, masterKey);
      const { ciphertext, nonce } = encryptJSON(result, masterKey, userIdBytes);
      db.saveDarkreelCreds(userId, ciphertext, nonce);
      return result;
    }
  } catch {
    return null;
  } finally {
    zeroBuffer(masterKey);
  }
}
