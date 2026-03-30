import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { encryptJSON, decryptJSON, zeroBuffer } from '../../crypto/index.js';

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

      const masterKey = sessions.get(userId);
      if (!masterKey) {
        reply.status(401).send({ success: false, error: 'Session expired, please re-login' });
        return;
      }

      const creds: DarkreelCreds = { server, username, password };
      const { ciphertext, nonce } = encryptJSON(creds, masterKey);

      db.saveDarkreelCreds(userId, ciphertext, nonce);
      reply.send({ success: true });
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
  const masterKey = sessions.get(userId);
  if (!masterKey) return null;

  const row = db.getDarkreelCreds(userId);
  if (!row) return null;

  try {
    return decryptJSON<DarkreelCreds>(row.encrypted_data, row.nonce, masterKey);
  } catch {
    return null;
  }
}
