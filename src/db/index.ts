import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  auth_salt: Buffer | null;       // Argon2id auth salt (null = legacy scrypt user)
  password_salt: Buffer;           // KDF salt (for master key encryption)
  encrypted_master_key: Buffer;
  master_key_nonce: Buffer;
  kdf_iterations: number;
  recovery_mk: Buffer | null;     // recovery-code-encrypted master key
  is_admin: number;
  created_at: string;
}

export interface DarkreelCredsRow {
  user_id: string;
  encrypted_data: Buffer;
  nonce: Buffer;
  updated_at: string;
}

const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class DB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();

    // Checkpoint WAL periodically to prevent transaction history accumulation.
    // wal_checkpoint(TRUNCATE) forces all WAL pages back into the main DB and
    // truncates the WAL file to zero bytes, eliminating forensic recovery of
    // past transactions.
    this.walTimer = setInterval(() => {
      try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* non-fatal */ }
    }, WAL_CHECKPOINT_INTERVAL_MS);
  }

  private walTimer: ReturnType<typeof setInterval>;

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt BLOB NOT NULL,
        encrypted_master_key BLOB NOT NULL,
        master_key_nonce BLOB NOT NULL,
        kdf_iterations INTEGER NOT NULL DEFAULT 100000,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%W', 'now'))
      );
    `);

    // Add kdf_iterations column for existing databases
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN kdf_iterations INTEGER NOT NULL DEFAULT 100000`);
    } catch {
      // Column already exists
    }

    // Add auth_salt column (null = legacy scrypt user, set = Argon2id user)
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN auth_salt BLOB`);
    } catch {
      // Column already exists
    }

    // Add recovery_mk column (recovery-code-encrypted master key)
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN recovery_mk BLOB`);
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS darkreel_creds (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_data BLOB NOT NULL,
        nonce BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%W', 'now'))
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Performance: index on username for login lookups
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);

  }

  close() {
    clearInterval(this.walTimer);
    // Final checkpoint before closing to leave no WAL residue
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* closing anyway */ }
    this.db.close();
  }

  // --- Users ---

  getUserCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  getUserById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  listUsers(): Array<{ id: string; username: string; is_admin: number; created_at: string }> {
    return this.db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at').all() as Array<{ id: string; username: string; is_admin: number; created_at: string }>;
  }

  createUser(opts: {
    id?: string;
    username: string;
    passwordHash: string;
    authSalt: Buffer | null;
    passwordSalt: Buffer;
    encryptedMasterKey: Buffer;
    masterKeyNonce: Buffer;
    recoveryMK: Buffer | null;
    isAdmin: boolean;
    kdfIterations?: number;
  }): string {
    const id = opts.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, auth_salt, password_salt, encrypted_master_key, master_key_nonce, kdf_iterations, recovery_mk, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.username, opts.passwordHash, opts.authSalt, opts.passwordSalt,
      opts.encryptedMasterKey, opts.masterKeyNonce, opts.kdfIterations ?? 600000,
      opts.recoveryMK, opts.isAdmin ? 1 : 0,
    );
    return id;
  }

  /**
   * Atomic update of all auth fields (password change, recovery, legacy upgrade).
   */
  updateUserAuth(userId: string, opts: {
    passwordHash: string;
    authSalt: Buffer;
    passwordSalt: Buffer;
    encryptedMasterKey: Buffer;
    masterKeyNonce: Buffer;
    recoveryMK: Buffer;
  }) {
    this.db.prepare(`
      UPDATE users
      SET password_hash = ?, auth_salt = ?, password_salt = ?, encrypted_master_key = ?,
          master_key_nonce = ?, recovery_mk = ?, kdf_iterations = 600000
      WHERE id = ?
    `).run(
      opts.passwordHash, opts.authSalt, opts.passwordSalt,
      opts.encryptedMasterKey, opts.masterKeyNonce, opts.recoveryMK, userId,
    );
  }

  deleteUser(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  }

  // --- Darkreel Credentials ---

  getDarkreelCreds(userId: string): DarkreelCredsRow | undefined {
    return this.db.prepare('SELECT * FROM darkreel_creds WHERE user_id = ?').get(userId) as DarkreelCredsRow | undefined;
  }

  saveDarkreelCreds(userId: string, encryptedData: Buffer, nonce: Buffer) {
    this.db.prepare(`
      INSERT INTO darkreel_creds (user_id, encrypted_data, nonce, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%W', 'now'))
      ON CONFLICT(user_id) DO UPDATE SET encrypted_data = excluded.encrypted_data, nonce = excluded.nonce, updated_at = strftime('%Y-%W', 'now')
    `).run(userId, encryptedData, nonce);
  }

  deleteDarkreelCreds(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM darkreel_creds WHERE user_id = ?').run(userId);
    return result.changes > 0;
  }

  hasDarkreelCreds(userId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM darkreel_creds WHERE user_id = ?').get(userId);
    return !!row;
  }

  // --- Settings ---

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}
