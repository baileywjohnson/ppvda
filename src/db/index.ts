import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: Buffer;
  encrypted_master_key: Buffer;
  master_key_nonce: Buffer;
  kdf_iterations: number;
  is_admin: number;
  created_at: string;
}

export interface DarkreelCredsRow {
  user_id: string;
  encrypted_data: Buffer;
  nonce: Buffer;
  updated_at: string;
}

export class DB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Add kdf_iterations column for existing databases
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN kdf_iterations INTEGER NOT NULL DEFAULT 100000`);
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS darkreel_creds (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_data BLOB NOT NULL,
        nonce BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  close() {
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
    username: string;
    passwordHash: string;
    passwordSalt: Buffer;
    encryptedMasterKey: Buffer;
    masterKeyNonce: Buffer;
    isAdmin: boolean;
    kdfIterations?: number;
  }): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO users (id, username, password_hash, password_salt, encrypted_master_key, master_key_nonce, kdf_iterations, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, opts.username, opts.passwordHash, opts.passwordSalt, opts.encryptedMasterKey, opts.masterKeyNonce, opts.kdfIterations ?? 600000, opts.isAdmin ? 1 : 0);
    return id;
  }

  updateUserPassword(userId: string, passwordHash: string, passwordSalt: Buffer, encryptedMasterKey: Buffer, masterKeyNonce: Buffer, kdfIterations?: number) {
    this.db.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?, encrypted_master_key = ?, master_key_nonce = ?, kdf_iterations = ?
      WHERE id = ?
    `).run(passwordHash, passwordSalt, encryptedMasterKey, masterKeyNonce, kdfIterations ?? 600000, userId);
  }

  updateUserKdf(userId: string, passwordSalt: Buffer, encryptedMasterKey: Buffer, masterKeyNonce: Buffer, kdfIterations: number) {
    this.db.prepare(`
      UPDATE users SET password_salt = ?, encrypted_master_key = ?, master_key_nonce = ?, kdf_iterations = ?
      WHERE id = ?
    `).run(passwordSalt, encryptedMasterKey, masterKeyNonce, kdfIterations, userId);
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
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET encrypted_data = excluded.encrypted_data, nonce = excluded.nonce, updated_at = datetime('now')
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
}
