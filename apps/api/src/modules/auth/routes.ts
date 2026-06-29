import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { loginSchema } from '@quotezen/shared';
import type { UserRole } from '@quotezen/shared';
import { unauthorized } from '../../errors.js';
import { parse } from '../../lib/validate.js';

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/auth/login', async (request) => {
    const { email, password } = parse(loginSchema, request.body);

    const user = await prisma.user.findUnique({ where: { email }, include: { role: true } });
    if (!user || !user.isActive) throw unauthorized();

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized();

    const payload = { id: user.id.toString(), email: user.email, role: user.role.name as UserRole };
    const token = app.jwt.sign(payload);
    return { token, user: payload };
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request) => {
    return { user: request.user };
  });
};
