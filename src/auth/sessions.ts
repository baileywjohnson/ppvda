import { zeroBuffer } from '../crypto/index.js';

/**
 * In-memory session store mapping userId → decrypted master_key.
 * Populated on login, cleared on logout or server restart.
 * The master key never touches disk — it only exists in RAM here.
 */
export class SessionStore {
  private keys = new Map<string, Buffer>();

  set(userId: string, masterKey: Buffer): void {
    // If there's an existing key, zero it first
    const existing = this.keys.get(userId);
    if (existing) zeroBuffer(existing);
    this.keys.set(userId, Buffer.from(masterKey));
  }

  get(userId: string): Buffer | undefined {
    return this.keys.get(userId);
  }

  delete(userId: string): void {
    const key = this.keys.get(userId);
    if (key) {
      zeroBuffer(key);
      this.keys.delete(userId);
    }
  }

  clear(): void {
    for (const key of this.keys.values()) {
      zeroBuffer(key);
    }
    this.keys.clear();
  }

  has(userId: string): boolean {
    return this.keys.has(userId);
  }
}
