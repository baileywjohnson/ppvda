import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { encrypt, decrypt, zeroBuffer } from '../../crypto/index.js';
import { exchangeCode } from '../../darkreel/client.js';
import { DarkreelError, normalizeDarkreelOrigin, publicKeyFingerprint } from '../../darkreel/http.js';

interface SettingsRouteOpts {
  db: DB;
  sessions: SessionStore;
  preHandler: preHandlerHookHandler;
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsRouteOpts) {
  const { db, sessions } = opts;

  // --- Darkreel connection status ---
  // Returns whether a delegation is configured and, if so, non-sensitive
  // metadata about it (server URL, Darkreel-side user ID, and a fingerprint
  // of the public key uploads are sealed to, for the user to compare with
  // Darkreel). Never returns the refresh token or anything derived from it.
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
          public_key_fingerprint: publicKeyFingerprint(row.public_key),
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
            server_url: { type: 'string', minLength: 1, maxLength: 2048 },
            authorization_code: { type: 'string', minLength: 1, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      const sessionId = (request as any).user.sid;
      // From the DB (see authenticate), not the JWT, so a demoted admin
      // loses the exception immediately.
      const isAdmin = !!(request as any).user.isAdmin;
      const { server_url, authorization_code } = request.body;

      // Only a bare origin is accepted and stored. https is required except
      // for admins, who may deliberately target private/internal Darkreel
      // deployments (same host, same LAN, Docker-internal) over plain http;
      // non-admins can neither pivot PPVDA's network position via the
      // exchange call nor expose the exchange to an on-path attacker who
      // could swap in their own public key.
      let origin: string;
      try {
        origin = normalizeDarkreelOrigin(server_url, isAdmin);
      } catch (err) {
        reply.status(400).send({
          success: false,
          error: err instanceof DarkreelError && err.code === 'INSECURE_URL'
            ? 'Server URL must use https://'
            : 'Server URL must be just the address, e.g. https://darkreel.example.com (no path, query or credentials)',
        });
        return;
      }
      if (origin.startsWith('http:')) {
        request.log.warn({ userId }, 'Admin connected Darkreel over plain http — the key exchange is not protected in transit');
      }

      // Exchange the one-shot code. Darkreel returns identical responses for
      // "not found" and "expired" so we don't try to distinguish. The client
      // resolves, validates and pins the host itself.
      let conn;
      try {
        conn = await exchangeCode(origin, authorization_code, { admin: isAdmin });
      } catch (err) {
        const code = err instanceof DarkreelError ? err.code : undefined;
        request.log.info({ userId, code: code ?? 'UNKNOWN' }, 'Darkreel code exchange failed');
        let error = 'Authorization code rejected — it may have expired or already been used';
        if (code === 'PRIVATE_HOST') error = 'Private/internal server URLs are not allowed';
        else if (code === 'UNREACHABLE' || code === 'TIMEOUT') error = 'Could not reach Darkreel server — check the URL';
        else if (code === 'SCOPE_MISMATCH') error = 'Darkreel issued a delegation that is not upload-only — refusing it';
        else if (code === 'BAD_RESPONSE' || code === 'RESPONSE_TOO_LARGE') error = 'The server did not respond like a Darkreel server';
        reply.status(400).send({ success: false, error });
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
            public_key_fingerprint: publicKeyFingerprint(conn.publicKey),
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
