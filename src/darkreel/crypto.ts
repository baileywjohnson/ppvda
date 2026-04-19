import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

// Darkreel's sealed-box format, matching internal/crypto/asymmetric.go on the
// server side byte-for-byte:
//
//   ephemeral_pk(32) || nonce(12) || AES-256-GCM(k, nonce, msg) ‖ tag(16)
//
// where k = HKDF-SHA256(ECDH(ephemeral_sk, recipient_pk), salt=empty,
//                       info="darkreel-seal-v1", 32 bytes).
//
// Anyone with the recipient's public key can seal; only the holder of the
// matching private key can open. This is what PPVDA uses to wrap per-file
// AES keys during an upload — PPVDA never needs the recipient's private key
// and cannot decrypt its own uploads after the fact. That's the blast-radius
// reduction the whole Shape 2 redesign is built around.

const SEAL_INFO = Buffer.from('darkreel-seal-v1', 'utf-8');
const SEAL_EPHPK_LEN = 32;
const SEAL_NONCE_LEN = 12;
const SEAL_TAG_LEN = 16;
export const SEAL_OVERHEAD = SEAL_EPHPK_LEN + SEAL_NONCE_LEN + SEAL_TAG_LEN; // 60

/**
 * Seal a short message (typically a 32-byte AES key) to the recipient's
 * X25519 public key. Output length = SEAL_OVERHEAD + message.length.
 */
export function seal(message: Buffer, recipientPubRaw: Buffer): Buffer {
  if (recipientPubRaw.length !== 32) {
    throw new Error(`recipient pubkey must be 32 bytes, got ${recipientPubRaw.length}`);
  }

  // Ephemeral X25519 keypair. `generateKeyPairSync` returns KeyObject
  // instances; we need the ephemeral public key as raw 32 bytes for the wire
  // format and the private KeyObject for ECDH.
  const { privateKey: ephPriv, publicKey: ephPub } = generateKeyPairSync('x25519');
  const ephPubJwk = ephPub.export({ format: 'jwk' }) as { x: string };
  const ephPubRaw = Buffer.from(ephPubJwk.x, 'base64url');
  if (ephPubRaw.length !== 32) {
    throw new Error(`ephemeral pubkey length unexpected: ${ephPubRaw.length}`);
  }

  // Recipient public KeyObject, imported from raw bytes via JWK.
  const recipPub = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: recipientPubRaw.toString('base64url') },
    format: 'jwk',
  });

  // ECDH shared secret, then HKDF to a single-use AES key.
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: recipPub });
  const aesKey = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), SEAL_INFO, 32));
  shared.fill(0); // best-effort — Buffer may still live until GC

  const nonce = randomBytes(SEAL_NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, { authTagLength: SEAL_TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(message), cipher.final()]);
  const tag = cipher.getAuthTag();
  aesKey.fill(0);

  return Buffer.concat([ephPubRaw, nonce, encrypted, tag]);
}
