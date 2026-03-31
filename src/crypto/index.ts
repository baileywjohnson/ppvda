import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, timingSafeEqual, scryptSync } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = 'sha256';
const AES_ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;
const SALT_LEN = 32;

// --- Master key ---

export function generateMasterKey(): Buffer {
  return randomBytes(32);
}

// --- Key derivation ---

export function generateSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

export function deriveKeyFromPassword(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST);
}

// --- AES-256-GCM encryption ---

export function encrypt(plaintext: Buffer, key: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(AES_ALGO, key, nonce, { authTagLength: AUTH_TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as: ciphertext || authTag
  return {
    ciphertext: Buffer.concat([encrypted, authTag]),
    nonce,
  };
}

export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): Buffer {
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LEN);
  const encrypted = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv(AES_ALGO, key, nonce, { authTagLength: AUTH_TAG_LEN });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// --- Password hashing (scrypt, no external deps) ---

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  // Format: salt:hash (both hex-encoded)
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');
  const computed = scryptSync(password, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return timingSafeEqual(computed, expectedHash);
}

// --- Password strength ---

export function isStrongPassword(pw: string): boolean {
  if (pw.length < 16 || pw.length > 128) return false;
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^a-zA-Z0-9\s]/.test(pw);
  return hasLetter && hasDigit && hasSymbol;
}

export const PASSWORD_REQUIREMENTS = '16+ characters with at least one letter, one number, and one symbol';

// --- Convenience: encrypt/decrypt JSON ---

export function encryptJSON(data: unknown, key: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  return encrypt(Buffer.from(JSON.stringify(data), 'utf-8'), key);
}

export function decryptJSON<T = unknown>(ciphertext: Buffer, nonce: Buffer, key: Buffer): T {
  const plain = decrypt(ciphertext, nonce, key);
  return JSON.parse(plain.toString('utf-8')) as T;
}

// --- Zero memory ---

export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
