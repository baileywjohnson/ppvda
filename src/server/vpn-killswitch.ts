import type { FastifyRequest, FastifyReply } from 'fastify';
import { isVpnHealthy, getVpnHealthDetails } from '../mullvad/health.js';

/**
 * Fastify pre-handler that fails closed when the VPN tunnel is not healthy.
 * Must run AFTER `authenticate` so the log carries a user identifier.
 *
 * Only gates routes whose outbound traffic would leak real-IP on tunnel drop:
 * extract (Playwright navigation), stream-download (ffmpeg fetch), and the
 * job pipeline extract step. Health endpoints and auth endpoints stay open so
 * operators can still observe / recover from a degraded state.
 */
export async function requireVpnHealthy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isVpnHealthy()) return;

  const details = getVpnHealthDetails();
  request.log.warn(
    {
      interface_ok: details?.interfaceOk ?? null,
      routing_ok: details?.routingOk ?? null,
    },
    'Request blocked by VPN kill-switch',
  );
  reply.status(503).send({
    success: false,
    error: 'VPN tunnel is not healthy — request blocked to prevent traffic leak',
    code: 'VPN_KILL_SWITCH',
  });
}
