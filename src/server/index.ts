import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from '../config.js';
import { parseProxyUrl, type ProxyConfig } from '../proxy/index.js';
import { AppError } from '../utils/errors.js';
import { healthRoutes } from './routes/health.js';
import { extractRoutes } from './routes/extract.js';
import { downloadRoutes } from './routes/download.js';

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    disableRequestLogging: true,
  });

  await app.register(cors);

  // Parse proxy config once
  let proxyConfig: ProxyConfig | undefined;
  if (config.proxyUrl) {
    proxyConfig = parseProxyUrl(config.proxyUrl);
    app.log.info('Proxy configured');
  }

  const routeOpts = {
    proxyConfig,
    downloadDir: config.downloadDir,
    ffmpegPath: config.ffmpegPath,
    defaultTimeoutMs: config.browserTimeoutMs,
    defaultNetworkIdleMs: config.networkIdleMs,
    downloadTimeoutMs: config.downloadTimeoutMs,
    preferredHosts: config.preferredHosts,
    blockedHosts: config.blockedHosts,
    allowedHosts: config.allowedHosts,
  };

  // Register routes
  await app.register(healthRoutes);
  await app.register(extractRoutes, routeOpts);
  await app.register(downloadRoutes, routeOpts);

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ code: error.code });
      reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    // Fastify validation errors
    const fastifyError = error as { validation?: unknown; message?: string };
    if (fastifyError.validation) {
      reply.status(400).send({
        success: false,
        error: fastifyError.message ?? 'Validation error',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    request.log.error({ code: error instanceof Error ? error.name : 'UnknownError' });
    reply.status(500).send({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  return app;
}
