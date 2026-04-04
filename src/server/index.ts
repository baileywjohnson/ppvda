import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from '../config.js';
import type { DB } from '../db/index.js';
import type { SessionStore } from '../auth/sessions.js';
import { parseProxyUrl, type ProxyConfig } from '../proxy/index.js';
import { getVpnStatus, getRelays, switchMullvadCountry, isVpnSwitching } from '../mullvad/index.js';
import { AppError } from '../utils/errors.js';
import { setupAuth } from '../auth/index.js';
import { JobStore } from '../jobs/store.js';
import { createPipeline } from '../jobs/pipeline.js';
import { healthRoutes } from './routes/health.js';
import { extractRoutes } from './routes/extract.js';
import { downloadRoutes } from './routes/download.js';
import { jobRoutes } from './routes/jobs.js';
import { streamDownloadRoutes } from './routes/stream-download.js';
import { thumbnailRoutes } from './routes/thumbnail.js';
import { adminRoutes } from './routes/admin.js';
import { settingsRoutes } from './routes/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp(config: AppConfig, db: DB, sessions: SessionStore) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    disableRequestLogging: true,
  });

  await app.register(cors, { origin: false });

  // Security headers
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'");
  });

  // Global rate limit: 100 requests per minute per IP
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Auth (JWT + cookie + login/logout/change-password routes)
  const { authenticate, requireAdmin } = await setupAuth(app, {
    db,
    sessions,
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
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/') || request.url.startsWith('/jobs')
      || request.url.startsWith('/stream-download') || request.url.startsWith('/thumbnail')
      || request.url.startsWith('/config') || request.url.startsWith('/admin') || request.url.startsWith('/settings')
      || request.url.startsWith('/extract')) {
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
    maxConcurrentDownloads: config.maxConcurrentDownloads,
    drkBinaryPath: config.drkBinaryPath,
    drkUploadTimeoutMs: config.drkUploadTimeoutMs,
  }, db, sessions, app.log);

  // Feature flags endpoint
  app.get('/config', { preHandler: authenticate }, async (request) => {
    const userId = (request as any).user.sub;
    const isAdmin = (request as any).user.isAdmin;
    const vpn = getVpnStatus();
    const hasProxy = !!proxyConfig || vpn.configured;
    return {
      enableThumbnails: config.enableThumbnails,
      darkreelConfigured: db.hasDarkreelCreds(userId),
      isAdmin,
      userId,
      vpn: { available: hasProxy, mullvad: vpn.configured, location: vpn.location },
    };
  });

  // Register routes
  await app.register(healthRoutes);
  await app.register(adminRoutes, { db, sessions, preHandler: authenticate, requireAdmin, vpnBypassHosts: config.vpnBypassHosts });
  await app.register(settingsRoutes, { db, sessions, preHandler: authenticate });
  await app.register(jobRoutes, { store: jobStore, pipeline, preHandler: authenticate });
  await app.register(extractRoutes, { ...routeOpts, preHandler: authenticate });
  await app.register(downloadRoutes, { ...routeOpts, preHandler: authenticate });
  await app.register(streamDownloadRoutes, { ...routeOpts, preHandler: authenticate });
  if (config.enableThumbnails) {
    await app.register(thumbnailRoutes, { ...routeOpts, preHandler: authenticate });
  }

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
