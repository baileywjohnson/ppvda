import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { createUser } from '../../auth/index.js';
import { isStrongPassword, isValidUsername, PASSWORD_REQUIREMENTS } from '../../crypto/index.js';
import { getRelays, switchMullvadCountry, getVpnStatus } from '../../mullvad/index.js';
import type { VpnPermissionStore } from '../vpn-permissions.js';

interface AdminRouteOpts {
  db: DB;
  sessions: SessionStore;
  preHandler: preHandlerHookHandler;
  requireAdmin: preHandlerHookHandler;
  vpnBypassHosts?: string[];
  vpnPermissions: VpnPermissionStore;
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

  // Create user (each user gets independent master key + recovery code)
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

      if (!isValidUsername(username)) {
        reply.status(400).send({ success: false, error: 'Username must be 3-64 alphanumeric characters' });
        return;
      }
      if (!isStrongPassword(password)) {
        reply.status(400).send({ success: false, error: PASSWORD_REQUIREMENTS });
        return;
      }
      if (db.getUserByUsername(username)) {
        reply.status(409).send({ success: false, error: 'Username already exists' });
        return;
      }

      const { userId, recoveryCode } = await createUser(db, username, password, isAdmin ?? false);
      reply.status(201).send({
        success: true,
        data: {
          id: userId,
          username,
          recovery_code: recoveryCode,
        },
      });
    },
  );

  // Delete user
  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    { preHandler: [opts.preHandler, opts.requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const adminUserId = (request as any).user.sub;

      if (id === adminUserId) {
        reply.status(400).send({ success: false, error: 'Cannot delete your own account' });
        return;
      }

      sessions.deleteAllForUser(id);
      opts.vpnPermissions.removeUser(id);

      if (!db.deleteUser(id)) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }

      reply.send({ success: true });
    },
  );

  // --- Registration toggle ---

  app.post<{ Body: { enabled: boolean } }>(
    '/admin/registration',
    {
      preHandler: [opts.preHandler, opts.requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          properties: {
            enabled: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      db.setSetting('allow_registration', request.body.enabled ? 'true' : 'false');
      return { success: true, data: { enabled: request.body.enabled } };
    },
  );

  // --- VPN Management (admin only) ---

  app.get(
    '/admin/vpn/relays',
    { preHandler: [opts.preHandler, opts.requireAdmin] },
    async (_request, reply) => {
      const vpn = getVpnStatus();
      if (!vpn.configured) {
        reply.status(400).send({ success: false, error: 'VPN is not configured on this server' });
        return;
      }
      try {
        const relays = await getRelays();
        return { success: true, data: { relays, currentLocation: vpn.location } };
      } catch (err) {
        reply.status(500).send({ success: false, error: 'Failed to fetch relay list' });
      }
    },
  );

  app.post<{ Body: { location: string } }>(
    '/admin/vpn/switch',
    {
      preHandler: [opts.preHandler, opts.requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['location'],
          properties: {
            location: { type: 'string', minLength: 2, maxLength: 10 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const vpn = getVpnStatus();
      if (!vpn.configured) {
        reply.status(400).send({ success: false, error: 'VPN is not configured on this server' });
        return;
      }

      try {
        const result = await switchMullvadCountry(
          request.body.location,
          request.log,
          opts.vpnBypassHosts,
        );
        return { success: true, data: { country: result.country, city: result.city, location: request.body.location } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Country switch failed';
        reply.status(400).send({ success: false, error: msg });
      }
    },
  );

  // --- VPN Permissions ---

  app.get(
    '/admin/vpn/permissions',
    { preHandler: [opts.preHandler, opts.requireAdmin] },
    async () => {
      return {
        success: true,
        data: {
          vpnDefault: opts.vpnPermissions.getDefault(),
          toggleUserIds: opts.vpnPermissions.listToggleUserIds(),
        },
      };
    },
  );

  app.put<{ Body: { vpnDefault: 'on' | 'off' } }>(
    '/admin/vpn/default',
    {
      preHandler: [opts.preHandler, opts.requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['vpnDefault'],
          properties: {
            vpnDefault: { type: 'string', enum: ['on', 'off'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      opts.vpnPermissions.setDefault(request.body.vpnDefault);
      return { success: true, data: { vpnDefault: request.body.vpnDefault } };
    },
  );

  app.put<{ Body: { userId: string; allowed: boolean } }>(
    '/admin/vpn/user-toggle',
    {
      preHandler: [opts.preHandler, opts.requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['userId', 'allowed'],
          properties: {
            userId: { type: 'string', minLength: 1 },
            allowed: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { userId, allowed } = request.body;
      if (!db.getUserById(userId)) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }
      if (allowed) {
        opts.vpnPermissions.grantToggle(userId);
      } else {
        opts.vpnPermissions.revokeToggle(userId);
      }
      return { success: true };
    },
  );
}
