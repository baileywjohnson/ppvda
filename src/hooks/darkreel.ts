import { refreshAccessToken, uploadFile, type DarkreelConnection } from '../darkreel/client.js';

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
  detail?: string;
}

export interface DrkUploadOptions {
  conn: DarkreelConnection;
  filePath: string;
  ffmpegPath: string;
  timeoutMs: number;
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
  const { conn, filePath, ffmpegPath, timeoutMs } = opts;

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(conn.serverUrl, conn.refreshToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    // Refresh-token rejection usually means the user revoked the delegation
    // from Darkreel's "Connected Apps" panel — surface that specifically so
    // the UI can prompt re-connect.
    if (msg.includes('Refresh token rejected') || msg.includes('401')) {
      return {
        success: false,
        error: 'Darkreel delegation has been revoked — reconnect from PPVDA Settings',
      };
    }
    return {
      success: false,
      error: 'Could not reach Darkreel server — check the server URL in Settings',
      detail: msg,
    };
  }

  try {
    await uploadFile({ conn, accessToken, filePath, ffmpegPath, timeoutMs });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    // Detect upload-endpoint scope/auth failures separately so users see
    // actionable messages rather than opaque 4xx text.
    if (msg.includes('403')) {
      return { success: false, error: 'Darkreel rejected the upload — the delegation may be scope-limited or revoked' };
    }
    return { success: false, error: 'Darkreel upload failed', detail: msg };
  }
}
