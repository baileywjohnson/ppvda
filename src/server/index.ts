import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from '../config.js';
import { parseProxyUrl, type ProxyConfig } from '../proxy/index.js';
import { AppError } from '../utils/errors.js';
import { setupAuth } from '../auth/index.js';
import { JobStore } from '../jobs/store.js';
import { createPipeline } from '../jobs/pipeline.js';
import { healthRoutes } from './routes/health.js';
import { extractRoutes } from './routes/extract.js';
import { downloadRoutes } from './routes/download.js';
import { jobRoutes } from './routes/jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    disableRequestLogging: true,
  });

  await app.register(cors);

  // Auth (JWT + cookie + login/logout routes)
  const authenticate = await setupAuth(app, {
    username: config.ppvdaUsername,
    password: config.ppvdaPassword,
    jwtSecret: config.jwtSecret,
  });

  // Serve static web UI
  const publicDir = join(__dirname, '..', '..', 'public');
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: false,
  });

  // SPA fallback — serve index.html for non-API, non-file routes
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/') || request.url.startsWith('/jobs')) {
      reply.status(404).send({ success: false, error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });

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

  // Job infrastructure
  const jobStore = new JobStore(config.maxJobHistory);
  const pipeline = createPipeline(jobStore, {
    ...routeOpts,
    darkreelServer: config.darkreelServer,
    darkreelUser: config.darkreelUser,
    darkreelPass: config.darkreelPass,
    drkBinaryPath: config.drkBinaryPath,
    drkUploadTimeoutMs: config.drkUploadTimeoutMs,
  }, app.log);

  // Register routes
  await app.register(healthRoutes);
  await app.register(jobRoutes, { store: jobStore, pipeline, preHandler: authenticate });
  await app.register(extractRoutes, { ...routeOpts, preHandler: authenticate });
  await app.register(downloadRoutes, { ...routeOpts, preHandler: authenticate });

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
