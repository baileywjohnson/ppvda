import { zeroBuffer } from '../crypto/index.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionEntry {
  key: Buffer;
  expiresAt: number;
}

/**
 * In-memory session store mapping userId → decrypted master_key.
 * Populated on login, cleared on logout or server restart.
 * The master key never touches disk — it only exists in RAM here.
 * Entries expire after 24 hours.
 */
export class SessionStore {
  private keys = new Map<string, SessionEntry>();

  set(userId: string, masterKey: Buffer): void {
    // If there's an existing key, zero it first
    const existing = this.keys.get(userId);
    if (existing) zeroBuffer(existing.key);
    this.keys.set(userId, {
      key: Buffer.from(masterKey),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  get(userId: string): Buffer | undefined {
    const entry = this.keys.get(userId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      zeroBuffer(entry.key);
      this.keys.delete(userId);
      return undefined;
    }
    return entry.key;
  }

  delete(userId: string): void {
    const entry = this.keys.get(userId);
    if (entry) {
      zeroBuffer(entry.key);
      this.keys.delete(userId);
    }
  }

  clear(): void {
    for (const entry of this.keys.values()) {
      zeroBuffer(entry.key);
    }
    this.keys.clear();
  }

  has(userId: string): boolean {
    // Check expiry on has() too
    const entry = this.keys.get(userId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      zeroBuffer(entry.key);
      this.keys.delete(userId);
      return false;
    }
    return true;
  }
}
