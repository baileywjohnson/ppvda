import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { encrypt, decrypt, zeroBuffer } from '../../crypto/index.js';
import { isPrivateUrl } from '../../utils/url.js';
import { exchangeCode } from '../../darkreel/client.js';

interface SettingsRouteOpts {
  db: DB;
  sessions: SessionStore;
  preHandler: preHandlerHookHandler;
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRouteOpts) {
  const { db, sessions } = opts;

  // --- Darkreel connection status ---
  // Returns whether a delegation is configured and, if so, non-sensitive
  // metadata about it (server URL and Darkreel-side user ID). Never returns
  // the refresh token or anything derived from it.
  app.get(
    '/settings/darkreel',
    { preHandler: [opts.preHandler] },
    async (request) => {
      const userId = (request as any).user.sub;
      const row = db.getDarkreelDelegation(userId);
      if (!row) return { success: true, data: { configured: false } };
      return {
        success: true,
        data: {
          configured: true,
          server_url: row.server_url,
          darkreel_user_id: row.darkreel_user_id,
          connected_at: row.connected_at,
        },
      };
    },
  );

  // --- Connect Darkreel ---
  // Copy-paste consent flow: user runs the "Authorize an App" flow in the
  // Darkreel SPA, receives a 2-minute single-use code, and pastes it here
  // along with the server URL. PPVDA exchanges the code for a refresh token
  // + public key, encrypts the refresh token under the user's master key
  // (AAD = userID so a DB leak alone cannot cross-decrypt), and stores it.
  //
  // PPVDA never holds a password for the Darkreel account, and the stored
  // refresh token grants upload-only capability — a PPVDA compromise that
  // extracts this row leaks only "attacker can post junk to the user's
  // Darkreel library until the user revokes", not decryption.
  app.post<{ Body: { server_url: string; authorization_code: string } }>(
    '/settings/darkreel/connect',
    {
      preHandler: [opts.preHandler],
      schema: {
        body: {
          type: 'object',
          required: ['server_url', 'authorization_code'],
          properties: {
            server_url: { type: 'string', minLength: 1 },
            authorization_code: { type: 'string', minLength: 1, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      const sessionId = (request as any).user.sid;
      const isAdmin = (request as any).user.isAdmin;
      const { server_url, authorization_code } = request.body;

      // Reuse the SSRF guard used by the old password-save route. Admins
      // may deliberately target private/internal Darkreel deployments
      // (same host, same LAN, Docker-internal); non-admins cannot pivot
      // PPVDA's network position via the exchange call's fetch.
      if (await isPrivateUrl(server_url)) {
        if (!isAdmin) {
          reply.status(400).send({ success: false, error: 'Private/internal server URLs are not allowed' });
          return;
        }
        const hostname = (() => { try { return new URL(server_url).hostname.toLowerCase(); } catch { return ''; } })();
        request.log.info({ userId, hostname }, 'Admin connected Darkreel to a private/internal URL');
      }

      // Basic URL shape check ahead of the fetch so typos return early.
      try {
        const u = new URL(server_url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          reply.status(400).send({ success: false, error: 'Server URL must be http:// or https://' });
          return;
        }
      } catch {
        reply.status(400).send({ success: false, error: 'Malformed server URL' });
        return;
      }

      // Exchange the one-shot code. Darkreel returns identical responses for
      // "not found" and "expired" so we don't try to distinguish.
      let conn;
      try {
        conn = await exchangeCode(server_url, authorization_code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        reply.status(400).send({
          success: false,
          error: msg.includes('fetch failed') || msg.includes('ECONN')
            ? 'Could not reach Darkreel server — check the URL'
            : 'Authorization code rejected — it may have expired or already been used',
        });
        return;
      }

      // Encrypt the refresh token under the user's PPVDA master key with
      // userID as AAD. Bind to THIS request's session — using any-session
      // lookup (getKeyForUser) could wrap the refresh token under an
      // about-to-expire session's key, making the delegation undecryptable
      // as soon as that session times out.
      const session = sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        reply.status(401).send({ success: false, error: 'Session expired, please re-login' });
        return;
      }
      const masterKey = session.key;
      try {
        const userIdBytes = Buffer.from(userId, 'utf-8');
        const { ciphertext, nonce } = encrypt(
          Buffer.from(conn.refreshToken, 'utf-8'),
          masterKey,
          userIdBytes,
        );
        db.saveDarkreelDelegation({
          userId,
          serverUrl: conn.serverUrl,
          darkreelUserId: conn.userId,
          delegationId: conn.delegationId,
          publicKey: conn.publicKey,
          encryptedRefreshToken: ciphertext,
          refreshTokenNonce: nonce,
        });
        reply.send({
          success: true,
          data: {
            server_url: conn.serverUrl,
            darkreel_user_id: conn.userId,
          },
        });
      } finally {
        zeroBuffer(masterKey);
      }
    },
  );

  // --- Disconnect Darkreel ---
  // Clears the local delegation record. Does NOT notify the Darkreel server;
  // the user revokes the delegation from Darkreel's "Connected Apps" panel
  // if they want server-side revocation. The two are independent: Darkreel-
  // side revocation makes our refresh token unusable (we'll fail-soft on
  // the next upload); local disconnect just removes our ability to try.
  app.delete(
    '/settings/darkreel',
    { preHandler: [opts.preHandler] },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      db.deleteDarkreelDelegation(userId);
      reply.send({ success: true });
    },
  );
}

/**
 * Fetch the decrypted refresh token + stored public key for a user's
 * configured Darkreel delegation. Used by the job pipeline at upload time.
 * Caller is responsible for zeroing the returned refreshToken buffer.
 */
export type DarkreelDelegationResult =
  | {
      state: 'ok';
      serverUrl: string;
      darkreelUserId: string;
      delegationId: string;
      publicKey: Buffer;
      refreshToken: string;
    }
  | { state: 'not-configured' }
  | { state: 'session-expired' }
  | { state: 'decrypt-failed' };

/**
 * Fetch the user's Darkreel delegation. Returns a discriminated result
 * because the three "can't use it" cases are semantically different and
 * used to be silently conflated by the job pipeline:
 *
 *   - `not-configured`: no row in the delegations table. The user just
 *     hasn't connected a Darkreel account; uploading to Darkreel is a
 *     no-op and the job flow retains the downloaded file locally.
 *   - `session-expired`: the master key isn't in the in-memory session
 *     store. The user logged out (or the session expired, or the server
 *     restarted) while the job was mid-flight. Without the master key
 *     we can't decrypt the refresh token — this is a real failure the
 *     user should see, not a silent "success."
 *   - `decrypt-failed`: master key is present but AES-GCM rejected the
 *     ciphertext. Usually means the delegation was stored under a
 *     different master key (e.g., the user changed their password
 *     without re-connecting). Real failure.
 *
 * The previous `null`-for-everything return made the pipeline mark
 * session-expired and decrypt-failed jobs as `done`, which is why
 * users hit "Send to Darkreel" and saw nothing arrive — it looked like
 * "Darkreel isn't configured" to the backend.
 */
export function getUserDarkreelDelegation(
  db: DB,
  sessions: SessionStore,
  userId: string,
): DarkreelDelegationResult {
  const row = db.getDarkreelDelegation(userId);
  if (!row) return { state: 'not-configured' };

  const masterKey = sessions.getKeyForUser(userId);
  if (!masterKey) return { state: 'session-expired' };

  try {
    const userIdBytes = Buffer.from(userId, 'utf-8');
    const refreshTokenBytes = decrypt(row.encrypted_refresh_token, row.refresh_token_nonce, masterKey, userIdBytes);
    const refreshToken = refreshTokenBytes.toString('utf-8');
    zeroBuffer(refreshTokenBytes);
    return {
      state: 'ok',
      serverUrl: row.server_url,
      darkreelUserId: row.darkreel_user_id,
      delegationId: row.delegation_id,
      publicKey: row.public_key,
      refreshToken,
    };
  } catch {
    return { state: 'decrypt-failed' };
  } finally {
    zeroBuffer(masterKey);
  }
}
