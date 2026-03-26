import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { extractVideos } from '../../extractor/index.js';
import { extractRequestSchema, extractResponseSchema } from '../schemas/extract.js';
import type { ProxyConfig } from '../../proxy/types.js';

interface ExtractBody {
  url: string;
  timeout?: number;
}

export async function extractRoutes(
  app: FastifyInstance,
  opts: { proxyConfig?: ProxyConfig; defaultTimeoutMs: number; defaultNetworkIdleMs: number; preferredHosts: string[]; blockedHosts: string[]; allowedHosts: string[]; preHandler?: preHandlerHookHandler },
) {
  app.post<{ Body: ExtractBody }>(
    '/extract',
    {
      schema: {
        body: extractRequestSchema,
        response: { 200: extractResponseSchema },
      },
      ...(opts.preHandler ? { preHandler: opts.preHandler } : {}),
    },
    async (request, reply) => {
      const { url, timeout } = request.body;

      const result = await extractVideos({
        url,
        timeoutMs: timeout ?? opts.defaultTimeoutMs,
        networkIdleMs: opts.defaultNetworkIdleMs,
        proxy: opts.proxyConfig,
        preferredHosts: opts.preferredHosts,
        blockedHosts: opts.blockedHosts,
        allowedHosts: opts.allowedHosts,
      });

      return { success: true, data: result };
    },
  );
}
