import type { FastifyInstance } from 'fastify';

const startTime = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: '0.1.0',
    };
  });
}
