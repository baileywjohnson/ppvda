import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { loginRequestSchema, loginResponseSchema } from '../server/schemas/auth.js';

interface AuthOpts {
  username: string;
  password: string;
  jwtSecret: string;
}

/**
 * Sets up JWT, cookie, login/logout routes, and returns the authenticate preHandler.
 * Must be called before routes are registered.
 */
export async function setupAuth(app: FastifyInstance, opts: AuthOpts) {
  await app.register(fastifyCookie);

  await app.register(fastifyJwt, {
    secret: opts.jwtSecret,
    cookie: { cookieName: 'token', signed: false },
  });

  // Auth preHandler — checks Bearer header, then cookie, then ?token= query param
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      // Fallback: check query param (needed for EventSource which can't set headers)
      const queryToken = (request.query as Record<string, string>)?.token;
      if (queryToken) {
        try {
          app.jwt.verify(queryToken);
          return;
        } catch { /* fall through */ }
      }
      reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
  };

  // Login route (public)
  app.post<{ Body: { username: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        body: loginRequestSchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;

      if (!safeEquals(username, opts.username) || !safeEquals(password, opts.password)) {
        reply.status(401).send({ success: false, error: 'Invalid credentials' });
        return;
      }

      const token = app.jwt.sign({ sub: username }, { expiresIn: '24h' });

      reply
        .setCookie('token', token, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: false,
        })
        .send({ success: true, token });
    },
  );

  // Logout route (clears cookie)
  app.post('/auth/logout', async (_request, reply) => {
    reply
      .clearCookie('token', { path: '/' })
      .send({ success: true });
  });

  return authenticate;
}

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
