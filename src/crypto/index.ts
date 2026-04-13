import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, timingSafeEqual, scryptSync } from 'node:crypto';
import argon2 from 'argon2';

export const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = 'sha256';
const AES_ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;
const SALT_LEN = 32;

// Argon2id params (matching Darkreel server)
const ARGON2_TIME = 3;
const ARGON2_MEMORY = 64 * 1024; // 64 MB in KiB
const ARGON2_PARALLELISM = 4;
const ARGON2_KEY_LEN = 32;

// Legacy scrypt params (for migration only)
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;

// --- Master key ---

export function generateMasterKey(): Buffer {
  return randomBytes(32);
}

// --- Salts ---

export function generateSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

// --- Argon2id key derivation (matches Darkreel's DeriveKey) ---

export async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    timeCost: ARGON2_TIME,
    memoryCost: ARGON2_MEMORY,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_KEY_LEN,
    salt,
    raw: true,
  }) as Promise<Buffer>;
}

// --- Argon2id password hashing (matches Darkreel's HashPassword) ---

export async function hashPassword(password: string, salt: Buffer): Promise<string> {
  const hash = await deriveKey(password, salt);
  const result = hash.toString('base64');
  zeroBuffer(hash);
  return result;
}

// --- Argon2id password verification (matches Darkreel's VerifyPassword) ---

export async function verifyPassword(password: string, salt: Buffer, storedHash: string): Promise<boolean> {
  const computed = await hashPassword(password, salt);
  return timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

// --- Legacy scrypt password verification (for migration) ---

export function verifyPasswordLegacy(password: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');
  const computed = scryptSync(password, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return timingSafeEqual(computed, expectedHash);
}

// --- PBKDF2 key derivation (legacy, for migration) ---

export function deriveKeyPBKDF2(password: string, salt: Buffer, iterations?: number): Buffer {
  return pbkdf2Sync(password, salt, iterations ?? PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST);
}

// --- AES-256-GCM encryption (separate nonce, optional AAD) ---

export function encrypt(plaintext: Buffer, key: Buffer, aad?: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(AES_ALGO, key, nonce, { authTagLength: AUTH_TAG_LEN });
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]),
    nonce,
  };
}

export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer, aad?: Buffer): Buffer {
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LEN);
  const encrypted = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv(AES_ALGO, key, nonce, { authTagLength: AUTH_TAG_LEN });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// --- AES-256-GCM encryption (embedded nonce, matches Darkreel's EncryptBlock) ---
// Format: nonce (12) || ciphertext || tag (16)

export function encryptBlock(plaintext: Buffer, key: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(AES_ALGO, key, nonce, { authTagLength: AUTH_TAG_LEN });
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, authTag]);
}

export function decryptBlock(data: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (data.length < NONCE_LEN + AUTH_TAG_LEN) {
    throw new Error('ciphertext too short');
  }
  const nonce = data.subarray(0, NONCE_LEN);
  const rest = data.subarray(NONCE_LEN);
  const authTag = rest.subarray(rest.length - AUTH_TAG_LEN);
  const encrypted = rest.subarray(0, rest.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv(AES_ALGO, key, nonce, { authTagLength: AUTH_TAG_LEN });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// --- Recovery codes ---

export function generateRecoveryCode(): Buffer {
  return randomBytes(32);
}

export function encryptMasterKeyForRecovery(masterKey: Buffer, recoveryCode: Buffer, userID: Buffer): Buffer {
  return encryptBlock(masterKey, recoveryCode, userID);
}

export function decryptMasterKeyWithRecovery(data: Buffer, recoveryCode: Buffer, userID: Buffer): Buffer {
  return decryptBlock(data, recoveryCode, userID);
}

// --- Password strength ---

export function isStrongPassword(pw: string): boolean {
  if (pw.length < 16 || pw.length > 128) return false;
  let hasLetter = false, hasDigit = false, hasSymbol = false;
  for (const c of pw) {
    if (/[a-zA-Z]/.test(c)) hasLetter = true;
    else if (/[0-9]/.test(c)) hasDigit = true;
    else if (/\s/.test(c)) return false; // reject whitespace (matching Darkreel)
    else hasSymbol = true;
  }
  return hasLetter && hasDigit && hasSymbol;
}

export const PASSWORD_REQUIREMENTS = '16-128 characters with at least one letter, one number, and one symbol (no spaces)';

// --- Username validation (matching Darkreel) ---

export function isValidUsername(u: string): boolean {
  if (u.length < 3 || u.length > 64) return false;
  return /^[a-zA-Z0-9]+$/.test(u);
}

// --- Convenience: encrypt/decrypt JSON ---

export function encryptJSON(data: unknown, key: Buffer, aad?: Buffer): { ciphertext: Buffer; nonce: Buffer } {
  return encrypt(Buffer.from(JSON.stringify(data), 'utf-8'), key, aad);
}

export function decryptJSON<T = unknown>(ciphertext: Buffer, nonce: Buffer, key: Buffer, aad?: Buffer): T {
  const plain = decrypt(ciphertext, nonce, key, aad);
  return JSON.parse(plain.toString('utf-8')) as T;
}

// --- Zero memory ---

export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}
