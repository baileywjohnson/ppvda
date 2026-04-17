import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { SignJWT, jwtVerify } from 'jose';
import type { DB } from '../db/index.js';
import type { SessionStore } from './sessions.js';
import {
  hashPassword, verifyPassword, verifyPasswordLegacy,
  deriveKey, deriveKeyPBKDF2,
  generateSalt, encrypt, decrypt,
  encryptBlock, encryptMasterKeyForRecovery, decryptMasterKeyWithRecovery,
  generateMasterKey, generateRecoveryCode,
  zeroBuffer, isStrongPassword, isValidUsername,
  PASSWORD_REQUIREMENTS,
} from '../crypto/index.js';

// --- Per-username rate limiter (matches Darkreel's AccountLimiter) ---

class AccountLimiter {
  private attempts = new Map<string, { count: number; windowStart: number }>();
  private maxAttempts = 10;
  private windowMs = 15 * 60 * 1000; // 15 minutes

  allow(username: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(username);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.attempts.set(username, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxAttempts;
  }
}

interface AuthOpts {
  db: DB;
  sessions: SessionStore;
  jwtSecret: string;
}

export interface UserContext {
  userId: string;
  sessionId: string;
  username: string;
  isAdmin: boolean;
}

interface JWTPayload {
  sub: string;    // userId
  sid: string;    // sessionId
  isAdmin: boolean;
}

export async function setupAuth(app: FastifyInstance, opts: AuthOpts) {
  const { db, sessions } = opts;
  const secret = new TextEncoder().encode(opts.jwtSecret);
  const accountLimiter = new AccountLimiter();

  await app.register(fastifyCookie);

  // --- JWT helpers ---
  async function signToken(payload: JWTPayload): Promise<string> {
    return new SignJWT({ isAdmin: payload.isAdmin, sid: payload.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(secret);
  }

  async function verifyToken(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });
    return {
      sub: payload.sub as string,
      sid: payload.sid as string,
      isAdmin: !!payload.isAdmin,
    };
  }

  // --- Extract token from request ---
  function extractToken(request: FastifyRequest): string | undefined {
    const cookieToken = request.cookies?.token;
    if (cookieToken) return cookieToken;
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return undefined;
  }

  // --- Auth preHandler ---
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(request);
    if (!token) {
      reply.status(401).send({ success: false, error: 'Unauthorized' });
      return reply;
    }

    let payload: JWTPayload;
    try {
      payload = await verifyToken(token);
    } catch {
      reply.clearCookie('token', { path: '/' });
      reply.status(401).send({ success: false, error: 'Unauthorized' });
      return reply;
    }

    // Verify session exists (by sessionId, not userId)
    if (!payload.sid || !sessions.has(payload.sid)) {
      reply.clearCookie('token', { path: '/' });
      reply.status(401).send({ success: false, error: 'Session expired' });
      return reply;
    }

    // Verify user still exists
    const userId = payload.sub;
    if (!userId || !db.getUserById(userId)) {
      reply.clearCookie('token', { path: '/' });
      reply.status(401).send({ success: false, error: 'Account no longer exists' });
      return reply;
    }

    (request as any).user = payload;
  };

  // --- Admin-only preHandler ---
  // Re-verify admin status from DB on every request (JWT claim alone is not trusted)
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    if (!user?.sub) {
      reply.status(403).send({ success: false, error: 'Admin access required' });
      return reply;
    }
    const dbUser = db.getUserById(user.sub);
    if (!dbUser || !dbUser.is_admin) {
      reply.status(403).send({ success: false, error: 'Admin access required' });
      return reply;
    }
  };

  // --- Helper: login a user and create session + token ---
  async function createSessionAndToken(
    userId: string,
    isAdmin: boolean,
    masterKey: Buffer,
  ): Promise<{ token: string; sessionId: string }> {
    const sessionId = sessions.generateId();
    sessions.set(sessionId, userId, masterKey);
    const token = await signToken({ sub: userId, sid: sessionId, isAdmin });
    return { token, sessionId };
  }

  // --- Helper: set auth cookie ---
  function setAuthCookie(reply: FastifyReply, token: string): void {
    reply.setCookie('token', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
    });
  }

  // --- Registration status (public endpoint) ---
  app.get('/auth/registration', async () => {
    const setting = db.getSetting('allow_registration');
    return { enabled: setting === 'true' };
  });

  // --- Register (public, rate-limited) ---
  app.post<{ Body: { username: string; password: string } }>(
    '/auth/register',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 3 },
            password: { type: 'string', minLength: 16 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      // Check if registration is enabled
      const setting = db.getSetting('allow_registration');
      if (setting !== 'true') {
        reply.status(403).send({ success: false, error: 'Registration is disabled' });
        return;
      }

      const { username, password } = request.body;

      if (!isValidUsername(username)) {
        reply.status(400).send({ success: false, error: 'Username must be 3-64 alphanumeric characters' });
        return;
      }
      if (!isStrongPassword(password)) {
        reply.status(400).send({ success: false, error: PASSWORD_REQUIREMENTS });
        return;
      }
      if (db.getUserByUsername(username)) {
        reply.status(400).send({ success: false, error: 'Registration failed.' });
        return;
      }

      // Generate user ID first — needed as AAD for master key encryption
      const userId = randomUUID();
      const userIdBytes = Buffer.from(userId, 'utf-8');

      // Generate dual salts (matching Darkreel)
      const authSalt = generateSalt();
      const kdfSalt = generateSalt();

      // Hash password with Argon2id
      const passwordHash = await hashPassword(password, authSalt);

      // Generate independent master key
      const masterKey = generateMasterKey();

      // Encrypt master key with password-derived key (Argon2id) + AAD
      const kdfKey = await deriveKey(password, kdfSalt);
      const { ciphertext: encMasterKey, nonce: masterKeyNonce } = encrypt(masterKey, kdfKey, userIdBytes);
      zeroBuffer(kdfKey);

      // Generate recovery code and encrypt master key with it
      const recoveryCode = generateRecoveryCode();
      const recoveryMK = encryptMasterKeyForRecovery(masterKey, recoveryCode, userIdBytes);
      const recoveryCodeB64 = recoveryCode.toString('base64url');
      zeroBuffer(recoveryCode);
      zeroBuffer(masterKey);

      db.createUser({
        id: userId,
        username,
        passwordHash,
        authSalt,
        passwordSalt: kdfSalt,
        encryptedMasterKey: encMasterKey,
        masterKeyNonce,
        recoveryMK,
        isAdmin: false,
      });

      reply.status(201).send({
        success: true,
        data: {
          id: userId,
          recovery_code: recoveryCodeB64,
        },
      });
    },
  );

  // --- Login ---
  app.post<{ Body: { username: string; password: string } }>(
    '/auth/login',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;

      // Per-username rate limit (prevents distributed brute-force)
      if (!accountLimiter.allow(username)) {
        // Dummy work so timing is indistinguishable
        const dummySalt = generateSalt();
        await deriveKey(password, dummySalt);
        reply.status(401).send({ success: false, error: 'Username and/or password is incorrect.' });
        return;
      }

      const user = db.getUserByUsername(username);
      if (!user) {
        // Dummy Argon2id derivation to prevent timing-based username enumeration
        const dummySalt = generateSalt();
        await deriveKey(password, dummySalt);
        reply.status(401).send({ success: false, error: 'Username and/or password is incorrect.' });
        return;
      }

      const isLegacy = user.auth_salt === null;

      // --- Verify password ---
      if (isLegacy) {
        // Legacy scrypt verification
        if (!verifyPasswordLegacy(password, user.password_hash)) {
          // Dummy Argon2id derivation to equalize timing with Argon2id users
          // (otherwise attackers could distinguish legacy vs migrated accounts by timing).
          const dummySalt = generateSalt();
          await deriveKey(password, dummySalt);
          reply.status(401).send({ success: false, error: 'Username and/or password is incorrect.' });
          return;
        }
      } else {
        // Argon2id verification
        if (!await verifyPassword(password, user.auth_salt!, user.password_hash)) {
          reply.status(401).send({ success: false, error: 'Username and/or password is incorrect.' });
          return;
        }
      }

      // --- Decrypt master key ---
      const userIdBytes = Buffer.from(user.id, 'utf-8');
      let masterKey: Buffer;

      if (isLegacy) {
        // Legacy: PBKDF2-derived key, no AAD
        const storedIterations = user.kdf_iterations ?? 100_000;
        const legacyKey = deriveKeyPBKDF2(password, user.password_salt, storedIterations);
        try {
          masterKey = decrypt(user.encrypted_master_key, user.master_key_nonce, legacyKey);
        } catch {
          zeroBuffer(legacyKey);
          reply.status(500).send({ success: false, error: 'Failed to decrypt session key' });
          return;
        }
        zeroBuffer(legacyKey);

        // Transparently upgrade to Argon2id + AAD + recovery code
        const newAuthSalt = generateSalt();
        const newKdfSalt = generateSalt();
        const newPasswordHash = await hashPassword(password, newAuthSalt);
        const newKdfKey = await deriveKey(password, newKdfSalt);
        const { ciphertext: newEncMK, nonce: newMKNonce } = encrypt(masterKey, newKdfKey, userIdBytes);
        zeroBuffer(newKdfKey);
        const newRecoveryCode = generateRecoveryCode();
        const newRecoveryMK = encryptMasterKeyForRecovery(masterKey, newRecoveryCode, userIdBytes);
        zeroBuffer(newRecoveryCode);

        db.updateUserAuth(user.id, {
          passwordHash: newPasswordHash,
          authSalt: newAuthSalt,
          passwordSalt: newKdfSalt,
          encryptedMasterKey: newEncMK,
          masterKeyNonce: newMKNonce,
          recoveryMK: newRecoveryMK,
        });
      } else {
        // New: Argon2id-derived key, with AAD
        const kdfKey = await deriveKey(password, user.password_salt);
        try {
          masterKey = decrypt(user.encrypted_master_key, user.master_key_nonce, kdfKey, userIdBytes);
        } catch {
          zeroBuffer(kdfKey);
          reply.status(500).send({ success: false, error: 'Failed to decrypt session key' });
          return;
        }
        zeroBuffer(kdfKey);
      }

      // Create session and token
      const { token } = await createSessionAndToken(user.id, !!user.is_admin, masterKey);
      zeroBuffer(masterKey);

      setAuthCookie(reply, token);
      reply.send({ success: true, token });
    },
  );

  // --- Logout ---
  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const user = (request as any).user;
    if (user?.sid) sessions.delete(user.sid);
    reply.clearCookie('token', { path: '/' }).send({ success: true });
  });

  // --- Recover (public, rate-limited) ---
  app.post<{ Body: { username: string; recoveryCode: string; newPassword: string } }>(
    '/auth/recover',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'recoveryCode', 'newPassword'],
          properties: {
            username: { type: 'string', minLength: 1 },
            recoveryCode: { type: 'string', minLength: 1 },
            newPassword: { type: 'string', minLength: 16 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { username, recoveryCode: recoveryCodeB64, newPassword } = request.body;

      if (!isStrongPassword(newPassword)) {
        reply.status(400).send({ success: false, error: PASSWORD_REQUIREMENTS });
        return;
      }

      // Per-username rate limit
      if (!accountLimiter.allow(username)) {
        const dummySalt = generateSalt();
        await deriveKey(newPassword, dummySalt);
        reply.status(400).send({ success: false, error: 'Username and/or recovery code is incorrect.' });
        return;
      }

      const user = db.getUserByUsername(username);
      if (!user || !user.recovery_mk) {
        // Dummy work to prevent timing-based enumeration
        const dummySalt = generateSalt();
        await deriveKey(newPassword, dummySalt);
        try { decryptMasterKeyWithRecovery(Buffer.alloc(60), Buffer.alloc(32), Buffer.from('dummy')); } catch {}
        reply.status(400).send({ success: false, error: 'Username and/or recovery code is incorrect.' });
        return;
      }

      // Decode recovery code — always attempt decryption to prevent timing leaks
      let recoveryCode: Buffer;
      let decodeOk = true;
      try {
        recoveryCode = Buffer.from(recoveryCodeB64, 'base64url');
        if (recoveryCode.length !== 32) {
          recoveryCode = Buffer.alloc(32);
          decodeOk = false;
        }
      } catch {
        recoveryCode = Buffer.alloc(32);
        decodeOk = false;
      }

      // Decrypt master key with recovery code
      const userIdBytes = Buffer.from(user.id, 'utf-8');
      let masterKey: Buffer;
      try {
        masterKey = decryptMasterKeyWithRecovery(user.recovery_mk, recoveryCode, userIdBytes);
      } catch {
        zeroBuffer(recoveryCode);
        reply.status(400).send({ success: false, error: 'Username and/or recovery code is incorrect.' });
        return;
      }
      zeroBuffer(recoveryCode);

      if (!decodeOk) {
        zeroBuffer(masterKey);
        reply.status(400).send({ success: false, error: 'Username and/or recovery code is incorrect.' });
        return;
      }

      // Re-encrypt with new password
      const newAuthSalt = generateSalt();
      const newKdfSalt = generateSalt();
      const newPasswordHash = await hashPassword(newPassword, newAuthSalt);
      const newKdfKey = await deriveKey(newPassword, newKdfSalt);
      const { ciphertext: newEncMK, nonce: newMKNonce } = encrypt(masterKey, newKdfKey, userIdBytes);
      zeroBuffer(newKdfKey);

      // Rotate recovery code
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryMK = encryptMasterKeyForRecovery(masterKey, newRecoveryCode, userIdBytes);
      const newRecoveryCodeB64 = newRecoveryCode.toString('base64url');
      zeroBuffer(newRecoveryCode);
      zeroBuffer(masterKey);

      // Atomic update
      db.updateUserAuth(user.id, {
        passwordHash: newPasswordHash,
        authSalt: newAuthSalt,
        passwordSalt: newKdfSalt,
        encryptedMasterKey: newEncMK,
        masterKeyNonce: newMKNonce,
        recoveryMK: newRecoveryMK,
      });

      // Invalidate all sessions
      sessions.deleteAllForUser(user.id);

      reply.send({
        success: true,
        data: { recovery_code: newRecoveryCodeB64 },
      });
    },
  );

  // --- Change Password ---
  app.post<{ Body: { oldPassword: string; newPassword: string } }>(
    '/auth/change-password',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['oldPassword', 'newPassword'],
          properties: {
            oldPassword: { type: 'string', minLength: 1 },
            newPassword: { type: 'string', minLength: 16 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { sub: userId, sid: sessionId } = (request as any).user;
      const { oldPassword, newPassword } = request.body;

      if (!isStrongPassword(newPassword)) {
        reply.status(400).send({ success: false, error: PASSWORD_REQUIREMENTS });
        return;
      }

      const user = db.getUserById(userId);
      if (!user) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }

      // Verify old password
      const isLegacy = user.auth_salt === null;
      if (isLegacy) {
        if (!verifyPasswordLegacy(oldPassword, user.password_hash)) {
          reply.status(400).send({ success: false, error: 'Current password is incorrect' });
          return;
        }
      } else {
        if (!await verifyPassword(oldPassword, user.auth_salt!, user.password_hash)) {
          reply.status(400).send({ success: false, error: 'Current password is incorrect' });
          return;
        }
      }

      // Decrypt master key with old password
      const userIdBytes = Buffer.from(user.id, 'utf-8');
      let masterKey: Buffer;

      if (isLegacy) {
        const storedIterations = user.kdf_iterations ?? 100_000;
        const legacyKey = deriveKeyPBKDF2(oldPassword, user.password_salt, storedIterations);
        try {
          masterKey = decrypt(user.encrypted_master_key, user.master_key_nonce, legacyKey);
        } catch {
          zeroBuffer(legacyKey);
          reply.status(500).send({ success: false, error: 'Failed to decrypt session key' });
          return;
        }
        zeroBuffer(legacyKey);
      } else {
        const oldKdfKey = await deriveKey(oldPassword, user.password_salt);
        try {
          masterKey = decrypt(user.encrypted_master_key, user.master_key_nonce, oldKdfKey, userIdBytes);
        } catch {
          zeroBuffer(oldKdfKey);
          reply.status(500).send({ success: false, error: 'Failed to decrypt session key' });
          return;
        }
        zeroBuffer(oldKdfKey);
      }

      // Re-encrypt master key with new password (always Argon2id + AAD)
      const newAuthSalt = generateSalt();
      const newKdfSalt = generateSalt();
      const newPasswordHash = await hashPassword(newPassword, newAuthSalt);
      const newKdfKey = await deriveKey(newPassword, newKdfSalt);
      const { ciphertext: newEncMK, nonce: newMKNonce } = encrypt(masterKey, newKdfKey, userIdBytes);
      zeroBuffer(newKdfKey);

      // Rotate recovery code
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryMK = encryptMasterKeyForRecovery(masterKey, newRecoveryCode, userIdBytes);
      const recoveryCodeB64 = newRecoveryCode.toString('base64url');
      zeroBuffer(newRecoveryCode);

      // Atomic update
      db.updateUserAuth(user.id, {
        passwordHash: newPasswordHash,
        authSalt: newAuthSalt,
        passwordSalt: newKdfSalt,
        encryptedMasterKey: newEncMK,
        masterKeyNonce: newMKNonce,
        recoveryMK: newRecoveryMK,
      });

      // Invalidate all existing sessions
      sessions.deleteAllForUser(user.id);

      // Create fresh session
      const { token } = await createSessionAndToken(user.id, !!user.is_admin, masterKey);
      zeroBuffer(masterKey);

      setAuthCookie(reply, token);
      reply.send({
        success: true,
        token,
        data: { recovery_code: recoveryCodeB64 },
      });
    },
  );

  // --- Delete Own Account ---
  app.delete<{ Body: { password: string } }>(
    '/auth/account',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            password: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { sub: userId } = (request as any).user;
      const { password } = request.body;

      const user = db.getUserById(userId);
      if (!user) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }

      // Verify password
      const isLegacy = user.auth_salt === null;
      if (isLegacy) {
        if (!verifyPasswordLegacy(password, user.password_hash)) {
          reply.status(400).send({ success: false, error: 'Password is incorrect' });
          return;
        }
      } else {
        if (!await verifyPassword(password, user.auth_salt!, user.password_hash)) {
          reply.status(400).send({ success: false, error: 'Password is incorrect' });
          return;
        }
      }

      sessions.deleteAllForUser(userId);
      db.deleteDarkreelCreds(userId);
      db.deleteUser(userId);

      reply.clearCookie('token', { path: '/' }).send({ success: true });
    },
  );

  return { authenticate, requireAdmin };
}

/**
 * Bootstrap: create admin user on first run.
 * Returns the recovery code (base64url-encoded) for logging.
 */
export async function bootstrapAdmin(db: DB, username: string, password: string): Promise<string> {
  const userId = randomUUID();
  const userIdBytes = Buffer.from(userId, 'utf-8');

  const authSalt = generateSalt();
  const kdfSalt = generateSalt();
  const passwordHash = await hashPassword(password, authSalt);

  const masterKey = generateMasterKey();
  const kdfKey = await deriveKey(password, kdfSalt);
  const { ciphertext: encMasterKey, nonce: masterKeyNonce } = encrypt(masterKey, kdfKey, userIdBytes);
  zeroBuffer(kdfKey);

  const recoveryCode = generateRecoveryCode();
  const recoveryMK = encryptMasterKeyForRecovery(masterKey, recoveryCode, userIdBytes);
  const recoveryCodeB64 = recoveryCode.toString('base64url');
  zeroBuffer(recoveryCode);
  zeroBuffer(masterKey);

  db.createUser({
    id: userId,
    username,
    passwordHash,
    authSalt,
    passwordSalt: kdfSalt,
    encryptedMasterKey: encMasterKey,
    masterKeyNonce,
    recoveryMK,
    isAdmin: true,
  });

  return recoveryCodeB64;
}

/**
 * Create a new user with an independent master key (called by admin).
 * Returns { userId, recoveryCode } — recovery code is base64url-encoded.
 */
export async function createUser(
  db: DB,
  username: string,
  password: string,
  isAdmin: boolean = false,
): Promise<{ userId: string; recoveryCode: string }> {
  const userId = randomUUID();
  const userIdBytes = Buffer.from(userId, 'utf-8');

  const authSalt = generateSalt();
  const kdfSalt = generateSalt();
  const passwordHash = await hashPassword(password, authSalt);

  const masterKey = generateMasterKey();
  const kdfKey = await deriveKey(password, kdfSalt);
  const { ciphertext: encMasterKey, nonce: masterKeyNonce } = encrypt(masterKey, kdfKey, userIdBytes);
  zeroBuffer(kdfKey);

  const recoveryCode = generateRecoveryCode();
  const recoveryMK = encryptMasterKeyForRecovery(masterKey, recoveryCode, userIdBytes);
  const recoveryCodeB64 = recoveryCode.toString('base64url');
  zeroBuffer(recoveryCode);
  zeroBuffer(masterKey);

  db.createUser({
    id: userId,
    username,
    passwordHash,
    authSalt,
    passwordSalt: kdfSalt,
    encryptedMasterKey: encMasterKey,
    masterKeyNonce,
    recoveryMK,
    isAdmin,
  });

  return { userId, recoveryCode: recoveryCodeB64 };
}
