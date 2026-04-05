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
  app.post<{ Body: { url?: string; videoUrl?: string; filename?: string; timeout?: number; autoPlay?: boolean } }>(
    '/jobs',
    {
      schema: { body: createJobRequestSchema, response: { 202: jobResponseSchema } },
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      preHandler: [preHandler],
    },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      const jobId = await pipeline.submit(userId, request.body);
      reply.status(202).send({ success: true, data: { id: jobId } });
    },
  );

  // List jobs (scoped to current user)
  app.get(
    '/jobs',
    {
      schema: { response: { 200: jobListResponseSchema } },
      preHandler: [preHandler],
    },
    async (request) => {
      const userId = (request as any).user.sub;
      return { success: true, data: store.list(userId) };
    },
  );

  // Get single job (scoped to current user)
  app.get<{ Params: { id: string } }>(
    '/jobs/:id',
    { preHandler: [preHandler] },
    async (request, reply) => {
      const userId = (request as any).user.sub;
      const job = store.get(request.params.id);
      if (!job || job.userId !== userId) {
        reply.status(404).send({ success: false, error: 'Job not found' });
        return;
      }
      const { filePath: _, userId: _u, ...rest } = job;
      return { success: true, data: rest };
    },
  );
}
