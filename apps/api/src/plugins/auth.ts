import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@quotezen/shared';
import type { AppConfig } from '../config.js';

/** Shape of the signed JWT payload / the authenticated user on the request. */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler that rejects unauthenticated requests (401). */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** preHandler factory that requires one of the given roles (403 otherwise). */
    requireRole: (
      ...roles: UserRole[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export const authPlugin = fp(
  async (app, opts: { config: AppConfig }) => {
    await app.register(fastifyJwt, {
      secret: opts.config.JWT_SECRET,
      sign: { expiresIn: opts.config.JWT_EXPIRES_IN },
    });

    app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.code(401).send({ error: { code: 'unauthorized', message: 'Authentication required' } });
      }
    });

    app.decorate('requireRole', (...roles: UserRole[]) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          await request.jwtVerify();
        } catch {
          await reply.code(401).send({ error: { code: 'unauthorized', message: 'Authentication required' } });
          return;
        }
        if (!roles.includes(request.user.role)) {
          await reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } });
        }
      };
    });
  },
  { name: 'auth' },
);
