import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { DB } from '../db/index.js';
import type { SessionStore } from './sessions.js';
import {
  hashPassword, verifyPassword,
  deriveKeyFromPassword, generateSalt,
  encrypt, decrypt, generateMasterKey,
  zeroBuffer, isStrongPassword, PASSWORD_REQUIREMENTS,
  PBKDF2_ITERATIONS,
} from '../crypto/index.js';

interface AuthOpts {
  db: DB;
  sessions: SessionStore;
  jwtSecret: string;
}

export interface UserContext {
  userId: string;
  username: string;
  isAdmin: boolean;
}

interface JWTPayload {
  sub: string;
  isAdmin: boolean;
}

export async function setupAuth(app: FastifyInstance, opts: AuthOpts) {
  const { db, sessions } = opts;
  const secret = new TextEncoder().encode(opts.jwtSecret);

  await app.register(fastifyCookie);

  // --- JWT helpers ---
  async function signToken(payload: JWTPayload): Promise<string> {
    return new SignJWT({ isAdmin: payload.isAdmin })
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
    return { sub: payload.sub as string, isAdmin: !!payload.isAdmin };
  }

  // --- Extract token from request ---
  function extractToken(request: FastifyRequest): string | undefined {
    // Cookie first
    const cookieToken = request.cookies?.token;
    if (cookieToken) return cookieToken;

    // Authorization header
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

    (request as any).user = payload;

    // Verify user still exists and has an active session (master key in RAM).
    // After a server restart the session store is empty, so this forces re-login
    // rather than leaving the user in a half-authenticated state.
    const userId = payload.sub;
    if (!userId || !db.getUserById(userId)) {
      reply.clearCookie('token', { path: '/' });
      reply.status(401).send({ success: false, error: 'Account no longer exists' });
      return reply;
    }
    if (!sessions.has(userId)) {
      reply.clearCookie('token', { path: '/' });
      reply.status(401).send({ success: false, error: 'Session expired' });
      return reply;
    }
  };

  // --- Admin-only preHandler ---
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    if (!user?.isAdmin) {
      reply.status(403).send({ success: false, error: 'Admin access required' });
      return reply;
    }
  };

  // --- Login ---
  app.post<{ Body: { username: string; password: string } }>(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
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

      const user = db.getUserByUsername(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        reply.status(401).send({ success: false, error: 'Invalid credentials' });
        return;
      }

      // Derive user key using stored iteration count and decrypt master key
      const storedIterations = user.kdf_iterations ?? 100_000;
      const userKey = deriveKeyFromPassword(password, user.password_salt, storedIterations);
      let masterKey: Buffer;
      try {
        masterKey = decrypt(user.encrypted_master_key, user.master_key_nonce, userKey);
      } catch {
        zeroBuffer(userKey);
        reply.status(500).send({ success: false, error: 'Failed to decrypt session key' });
        return;
      }
      zeroBuffer(userKey);

      // Transparently upgrade KDF iterations if below current target
      if (storedIterations < PBKDF2_ITERATIONS) {
        const newSalt = generateSalt();
        const newUserKey = deriveKeyFromPassword(password, newSalt, PBKDF2_ITERATIONS);
        const { ciphertext: newEncMasterKey, nonce: newNonce } = encrypt(masterKey, newUserKey);
        zeroBuffer(newUserKey);
        db.updateUserKdf(user.id, newSalt, newEncMasterKey, newNonce, PBKDF2_ITERATIONS);
      }

      // Store master key in session
      sessions.set(user.id, masterKey);
      zeroBuffer(masterKey);

      const token = await signToken({ sub: user.id, isAdmin: !!user.is_admin });

      reply
        .setCookie('token', token, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: process.env.NODE_ENV === 'production',
        })
        .send({ success: true, token });
    },
  );

  // --- Logout ---
  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const user = (request as any).user;
    if (user?.sub) sessions.delete(user.sub);
    reply.clearCookie('token', { path: '/' }).send({ success: true });
  });

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
      if (!user || !verifyPassword(password, user.password_hash)) {
        reply.status(400).send({ success: false, error: 'Password is incorrect' });
        return;
      }

      sessions.delete(userId);
      db.deleteDarkreelCreds(userId);
      db.deleteUser(userId);

      reply.clearCookie('token', { path: '/' }).send({ success: true });
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
      const { sub: userId } = (request as any).user;
      const { oldPassword, newPassword } = request.body;

      if (!isStrongPassword(newPassword)) {
        reply.status(400).send({ success: false, error: PASSWORD_REQUIREMENTS });
        return;
      }

      const user = db.getUserById(userId);
      if (!user || !verifyPassword(oldPassword, user.password_hash)) {
        reply.status(400).send({ success: false, error: 'Current password is incorrect' });
        return;
      }

      // Get master key from session
      const masterKey = sessions.get(userId);
      if (!masterKey) {
        reply.status(401).send({ success: false, error: 'Session expired, please re-login' });
        return;
      }

      // Re-encrypt master key with new password
      const newPasswordHash = hashPassword(newPassword);
      const newSalt = generateSalt();
      const newUserKey = deriveKeyFromPassword(newPassword, newSalt);
      const { ciphertext: newEncMasterKey, nonce: newMasterKeyNonce } = encrypt(masterKey, newUserKey);
      zeroBuffer(newUserKey);

      db.updateUserPassword(userId, newPasswordHash, newSalt, newEncMasterKey, newMasterKeyNonce, PBKDF2_ITERATIONS);

      reply.send({ success: true });
    },
  );

  return { authenticate, requireAdmin };
}

/**
 * Bootstrap: create admin user and generate master key on first run.
 */
export function bootstrapAdmin(db: DB, username: string, password: string): Buffer {
  const masterKey = generateMasterKey();

  const passwordHash = hashPassword(password);
  const salt = generateSalt();
  const userKey = deriveKeyFromPassword(password, salt);
  const { ciphertext: encMasterKey, nonce: masterKeyNonce } = encrypt(masterKey, userKey);
  zeroBuffer(userKey);

  db.createUser({
    username,
    passwordHash,
    passwordSalt: salt,
    encryptedMasterKey: encMasterKey,
    masterKeyNonce,
    isAdmin: true,
  });

  return masterKey;
}

/**
 * Create a new user with the shared master key (called by admin).
 */
export function createUser(db: DB, masterKey: Buffer, username: string, password: string, isAdmin: boolean = false): string {
  const passwordHash = hashPassword(password);
  const salt = generateSalt();
  const userKey = deriveKeyFromPassword(password, salt);
  const { ciphertext: encMasterKey, nonce: masterKeyNonce } = encrypt(masterKey, userKey);
  zeroBuffer(userKey);

  return db.createUser({
    username,
    passwordHash,
    passwordSalt: salt,
    encryptedMasterKey: encMasterKey,
    masterKeyNonce,
    isAdmin,
  });
}
