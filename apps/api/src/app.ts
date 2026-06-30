import './lib/json.js'; // installs BigInt JSON serialisation (side-effect import)
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { AppError } from './errors.js';
import { authPlugin } from './plugins/auth.js';
import { adminRoutes } from './modules/admin/routes.js';
import { userRoutes } from './modules/admin/users.js';
import { authRoutes } from './modules/auth/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { quoteRoutes } from './modules/quotes/routes.js';
import { ruleRoutes } from './modules/rules/routes.js';

export const buildApp = async (config: AppConfig): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: config.NODE_ENV !== 'test',
    ajv: { customOptions: { coerceTypes: false } },
  });

  await app.register(cors, { origin: true });

  // Accept an empty body on application/json requests (e.g. POST /recompute with no payload),
  // instead of Fastify's default 400 "Body cannot be empty".
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  await app.register(authPlugin, { config });

  // Consistent error envelope for every thrown/raised error.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.issues,
        },
      });
    }
    // Prisma unique-constraint violation → 409.
    if (typeof (error as { code?: string }).code === 'string' && (error as { code: string }).code === 'P2002') {
      return reply.code(409).send({ error: { code: 'conflict', message: 'Resource already exists' } });
    }
    app.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply
      .code(statusCode >= 400 ? statusCode : 500)
      .send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(quoteRoutes);
  await app.register(adminRoutes);
  await app.register(userRoutes);
  await app.register(ruleRoutes);

  return app;
};
