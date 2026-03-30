import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import type { DB } from '../db/index.js';
import type { SessionStore } from './sessions.js';
import {
  hashPassword, verifyPassword,
  deriveKeyFromPassword, generateSalt,
  encrypt, decrypt, generateMasterKey,
  zeroBuffer,
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

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username: string; isAdmin: boolean };
    user: { sub: string; username: string; isAdmin: boolean };
  }
}

export async function setupAuth(app: FastifyInstance, opts: AuthOpts) {
  const { db, sessions } = opts;

  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: opts.jwtSecret,
    cookie: { cookieName: 'token', signed: false },
  });

  // --- Auth preHandler ---
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      // Fallback: query param for SSE/EventSource
      const queryToken = (request.query as Record<string, string>)?.token;
      if (queryToken) {
        try {
          const payload = app.jwt.verify<{ sub: string; username: string; isAdmin: boolean }>(queryToken);
          (request as any).user = payload;
        } catch {
          reply.status(401).send({ success: false, error: 'Unauthorized' });
          return;
        }
      } else {
        reply.status(401).send({ success: false, error: 'Unauthorized' });
        return;
      }
    }

    // Verify user still exists in DB (catches deleted users with valid JWTs)
    const userId = (request as any).user?.sub;
    if (!userId || !db.getUserById(userId)) {
      reply.clearCookie('token', { path: '/' });
      reply.status(401).send({ success: false, error: 'Account no longer exists' });
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

      // Derive user key and decrypt master key
      const userKey = deriveKeyFromPassword(password, user.password_salt);
      let masterKey: Buffer;
      try {
        masterKey = decrypt(user.encrypted_master_key, user.master_key_nonce, userKey);
      } catch {
        zeroBuffer(userKey);
        reply.status(500).send({ success: false, error: 'Failed to decrypt session key' });
        return;
      }
      zeroBuffer(userKey);

      // Store master key in session
      sessions.set(user.id, masterKey);
      zeroBuffer(masterKey);

      const token = app.jwt.sign(
        { sub: user.id, username: user.username, isAdmin: !!user.is_admin },
        { expiresIn: '24h' },
      );

      reply
        .setCookie('token', token, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: false,
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
            newPassword: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { sub: userId } = (request as any).user;
      const { oldPassword, newPassword } = request.body;

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

      db.updateUserPassword(userId, newPasswordHash, newSalt, newEncMasterKey, newMasterKeyNonce);

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
