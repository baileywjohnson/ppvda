import { refreshAccessToken, uploadFile, type DarkreelConnection } from '../darkreel/client.js';
import { DarkreelError } from '../darkreel/http.js';

// Shape 2 Darkreel upload hook. Replaces the previous darkreel-cli subprocess
// spawn with a native Node implementation that speaks the sealed-box upload
// protocol directly.
//
// What PPVDA holds at rest (in darkreel_delegations):
//   - the user's Darkreel server URL
//   - the user's Darkreel user_id (opaque)
//   - the delegation_id (for server-side revocation UI)
//   - the user's Darkreel X25519 PUBLIC key (32 bytes, public by definition)
//   - the refresh token, AES-GCM-wrapped under the PPVDA user's master key
//
// What PPVDA does NOT hold at rest: any private key, any symmetric decryption
// key for Darkreel content, any password. A PPVDA compromise that extracts
// this table grants "upload junk to connected Darkreel accounts until the
// user revokes" — nothing else. That's the Shape 2 blast-radius property.

export interface DrkUploadResult {
  success: boolean;
  error?: string;
  /** Machine-readable failure code — safe to log (no hostnames or bodies). */
  code?: string;
}

export interface DrkUploadOptions {
  conn: DarkreelConnection;
  /** From the DB at call time: admin-connected URLs may be http / private. */
  admin: boolean;
  filePath: string;
  ffmpegPath: string;
  timeoutMs: number;
}

/** Log-safe code for any error thrown by the client. */
function errorCode(err: unknown): string {
  if (err instanceof DarkreelError) return err.status !== undefined ? `${err.code}_${err.status}` : err.code;
  return 'LOCAL_ERROR';
}

/**
 * Encrypt and upload a single file to Darkreel using a connected delegation.
 * The refresh token in conn is traded for a short-lived upload-scoped JWT,
 * per-file symmetric keys are generated and sealed to conn.publicKey, and
 * the file is streamed chunk-by-chunk with AES-256-GCM.
 *
 * Returns { success: false, error: ... } on any failure; never throws.
 */
export async function uploadToDarkreel(opts: DrkUploadOptions): Promise<DrkUploadResult> {
  const { conn, admin, filePath, ffmpegPath, timeoutMs } = opts;

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(conn.serverUrl, conn.refreshToken, { admin });
  } catch (err) {
    const code = errorCode(err);
    const dErr = err instanceof DarkreelError ? err.code : undefined;
    // Refresh-token rejection usually means the user revoked the delegation
    // from Darkreel's "Connected Apps" panel — surface that specifically so
    // the UI can prompt re-connect.
    if (dErr === 'REVOKED' || dErr === 'SCOPE_MISMATCH') {
      return { success: false, code, error: 'Darkreel delegation has been revoked — reconnect from PPVDA Settings' };
    }
    // The stored URL no longer passes validation (http for a non-admin,
    // a path, a host that now resolves to a private address, …).
    if (dErr === 'INVALID_URL' || dErr === 'INSECURE_URL' || dErr === 'PRIVATE_HOST') {
      return { success: false, code, error: 'The saved Darkreel server URL is no longer allowed — reconnect from PPVDA Settings using an https:// URL' };
    }
    return { success: false, code, error: 'Could not reach Darkreel server — check the server URL in Settings' };
  }

  try {
    await uploadFile({ conn, admin, accessToken, filePath, ffmpegPath, timeoutMs });
    return { success: true };
  } catch (err) {
    // Detect upload-endpoint scope/auth failures separately so users see
    // actionable messages rather than opaque 4xx text.
    if (err instanceof DarkreelError && err.code === 'HTTP_STATUS' && (err.status === 401 || err.status === 403)) {
      return { success: false, code: errorCode(err), error: 'Darkreel rejected the upload — the delegation may be scope-limited or revoked, or storage quota is exhausted' };
    }
    return { success: false, code: errorCode(err), error: 'Darkreel upload failed' };
  }
}
