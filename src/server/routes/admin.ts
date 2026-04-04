import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DB } from '../../db/index.js';
import type { SessionStore } from '../../auth/sessions.js';
import { createUser } from '../../auth/index.js';
import { isStrongPassword, PASSWORD_REQUIREMENTS } from '../../crypto/index.js';
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

      // Clear their session and VPN permissions
      sessions.delete(id);
      opts.vpnPermissions.removeUser(id);

      if (!db.deleteUser(id)) {
        reply.status(404).send({ success: false, error: 'User not found' });
        return;
      }

      reply.send({ success: true });
    },
  );

  // --- VPN Management (admin only) ---

  // Get available VPN countries/cities
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

  // Switch VPN country
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

  // --- VPN Permissions (admin only, in-memory) ---

  // Get current VPN policy
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

  // Set server-wide VPN default
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

  // Grant or revoke VPN toggle permission for a user
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
