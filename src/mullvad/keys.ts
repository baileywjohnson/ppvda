import { generateKeyPairSync } from 'node:crypto';

export interface WireGuardKeyPair {
  privateKey: string; // base64
  publicKey: string;  // base64
}

/**
 * Generate a WireGuard (Curve25519/X25519) key pair using Node's crypto module.
 */
export function generateWireGuardKeys(): WireGuardKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // X25519 keys in DER encoding have headers — raw 32-byte key is at the end
  const rawPrivate = privateKey.subarray(-32);
  const rawPublic = publicKey.subarray(-32);

  return {
    privateKey: rawPrivate.toString('base64'),
    publicKey: rawPublic.toString('base64'),
  };
}
