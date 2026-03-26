import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { JobStore } from '../../jobs/store.js';
import type { Pipeline } from '../../jobs/pipeline.js';
import { createJobRequestSchema, jobResponseSchema, jobListResponseSchema } from '../schemas/jobs.js';

interface JobsRouteOpts {
  store: JobStore;
  pipeline: Pipeline;
  preHandler: preHandlerHookHandler;
}

export async function jobRoutes(app: FastifyInstance, opts: JobsRouteOpts) {
  const { store, pipeline, preHandler } = opts;

  // Submit a new job
  app.post<{ Body: { url?: string; videoUrl?: string; filename?: string; timeout?: number } }>(
    '/jobs',
    {
      schema: { body: createJobRequestSchema, response: { 202: jobResponseSchema } },
      preHandler: [preHandler],
    },
    async (request, reply) => {
      const jobId = await pipeline.submit(request.body);
      reply.status(202).send({ success: true, data: { id: jobId } });
    },
  );

  // List all jobs
  app.get(
    '/jobs',
    {
      schema: { response: { 200: jobListResponseSchema } },
      preHandler: [preHandler],
    },
    async () => {
      return { success: true, data: store.list() };
    },
  );

  // Get single job
  app.get<{ Params: { id: string } }>(
    '/jobs/:id',
    { preHandler: [preHandler] },
    async (request, reply) => {
      const job = store.get(request.params.id);
      if (!job) {
        reply.status(404).send({ success: false, error: 'Job not found' });
        return;
      }
      const { filePath: _, ...rest } = job;
      return { success: true, data: rest };
    },
  );

  // SSE stream for real-time job updates
  app.get(
    '/jobs/events',
    { preHandler: [preHandler] },
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send current state
      for (const job of store.list()) {
        reply.raw.write(`data: ${JSON.stringify(job)}\n\n`);
      }

      // Subscribe to updates
      const unsubscribe = store.subscribe((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keep-alive ping every 30s
      const keepAlive = setInterval(() => {
        reply.raw.write(': ping\n\n');
      }, 30000);

      request.raw.on('close', () => {
        unsubscribe();
        clearInterval(keepAlive);
      });
    },
  );
}
