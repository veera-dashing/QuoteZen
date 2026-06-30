import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';

/**
 * Infrastructure probes (P1-01.3). Unauthenticated by design — these are consumed by load
 * balancers / orchestrators, not end users, and must never leak secrets in their bodies.
 *
 * - GET /health (liveness): process is up; does NOT touch the DB.
 * - GET /ready  (readiness): cheap `SELECT 1` round-trip to confirm the DB is reachable.
 */
export const healthRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch (err) {
      // Log the real cause server-side; return a generic message so we don't leak connection details.
      app.log.error(err, 'readiness check failed: database unreachable');
      return reply.code(503).send({ status: 'not_ready', error: 'database unreachable' });
    }
  });
};
