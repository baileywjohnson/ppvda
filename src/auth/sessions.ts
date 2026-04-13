import { randomBytes } from 'node:crypto';
import { zeroBuffer } from '../crypto/index.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (matches JWT expiry)

interface SessionEntry {
  userId: string;
  key: Buffer;
  createdAt: number;
}

/**
 * In-memory session store mapping sessionID → { userId, masterKey }.
 * Master keys are never persisted to disk — they only exist in RAM here.
 * Sessions are indexed by a random session ID (not user ID), allowing
 * multiple sessions per user and per-session invalidation.
 */
export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Generate a cryptographically random session ID. */
  generateId(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Store a master key for a session. Copies the key buffer. */
  set(sessionId: string, userId: string, masterKey: Buffer): void {
    const existing = this.sessions.get(sessionId);
    if (existing) zeroBuffer(existing.key);
    this.sessions.set(sessionId, {
      userId,
      key: Buffer.from(masterKey),
      createdAt: Date.now(),
    });
  }

  /** Get session data by session ID. Returns a copy of the key. */
  get(sessionId: string): { userId: string; key: Buffer } | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() > entry.createdAt + SESSION_TTL_MS) {
      zeroBuffer(entry.key);
      this.sessions.delete(sessionId);
      return undefined;
    }
    return { userId: entry.userId, key: Buffer.from(entry.key) };
  }

  /** Check if a valid (non-expired) session exists without copying the key. */
  has(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (Date.now() > entry.createdAt + SESSION_TTL_MS) {
      zeroBuffer(entry.key);
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * Get master key for a user (any valid session).
   * Used by async operations (job pipeline) that only know the userId.
   */
  getKeyForUser(userId: string): Buffer | undefined {
    const now = Date.now();
    for (const [sid, entry] of this.sessions) {
      if (entry.userId === userId) {
        if (now > entry.createdAt + SESSION_TTL_MS) {
          zeroBuffer(entry.key);
          this.sessions.delete(sid);
          continue;
        }
        return Buffer.from(entry.key);
      }
    }
    return undefined;
  }

  /** Delete a specific session, zeroing the key. */
  delete(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      zeroBuffer(entry.key);
      this.sessions.delete(sessionId);
    }
  }

  /** Delete all sessions for a user, zeroing all keys. */
  deleteAllForUser(userId: string): void {
    for (const [sid, entry] of this.sessions) {
      if (entry.userId === userId) {
        zeroBuffer(entry.key);
        this.sessions.delete(sid);
      }
    }
  }

  /** Start background cleanup of expired sessions (every minute). */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, entry] of this.sessions) {
        if (now > entry.createdAt + SESSION_TTL_MS) {
          zeroBuffer(entry.key);
          this.sessions.delete(sid);
        }
      }
    }, 60_000);
    // Allow the process to exit even if this timer is running
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Zero and remove all sessions. */
  clear(): void {
    for (const entry of this.sessions.values()) {
      zeroBuffer(entry.key);
    }
    this.sessions.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
