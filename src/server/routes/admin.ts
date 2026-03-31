import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { createUser } from '../../auth/index.js';
import { isStrongPassword, PASSWORD_REQUIREMENTS } from '../../crypto/index.js';

interface AdminRouteOpts {
  db: DB;
  sessions: SessionStore;
  preHandler: preHandlerHookHandler;
  requireAdmin: preHandlerHookHandler;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOpts) {
  const { db, sessions } = opts;

  // List users
  app.get(
    '/admin/users',
    { preHandler: [opts.preHandler, opts.requireAdmin] },
    async () => {
      return { success: true, data: db.listUsers() };
    },
  );

  // Create user
  app.post<{ Body: { username: string; password: string; isAdmin?: boolean } }>(
    '/admin/users',
    {
      preHandler: [opts.preHandler, opts.requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 3 },
            password: { type: 'string', minLength: 16 },
            isAdmin: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { username, password, isAdmin } = request.body;
      const adminUserId = (request as any).user.sub;

      if (!isStrongPassword(password)) {
        reply.status(400).send({ success: false, error: PASSWORD_REQUIREMENTS });
        return;
      }

      // Check username availability
      if (db.getUserByUsername(username)) {
        reply.status(409).send({ success: false, error: 'Username already exists' });
        return;
      }

      // Get master key from admin's session
      const masterKey = sessions.get(adminUserId);
      if (!masterKey) {
        reply.status(401).send({ success: false, error: 'Session expired, please re-login' });
        return;
      }

      const userId = createUser(db, masterKey, username, password, isAdmin ?? false);
      reply.status(201).send({ success: true, data: { id: userId, username } });
    },
  );

  // Delete user
  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    { preHandler: [opts.preHandler, opts.requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const adminUserId = (request as any).user.sub;

      // Prevent self-deletion
      if (id === adminUserId) {
        reply.status(400).send({ success: false, error: 'Cannot delete your own account' });
        return;
      }

      // Clear their session
      sessions.delete(id);

      if (!db.deleteUser(id)) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }

      reply.send({ success: true });
    },
  );
}
