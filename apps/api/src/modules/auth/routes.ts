import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { loginSchema, updateMeSchema } from '@quotezen/shared';
import type { UserRole } from '@quotezen/shared';
import { unauthorized } from '../../errors.js';
import { parse } from '../../lib/validate.js';

/** The self-profile shape returned to the client (JWT payload + persisted UI preferences). */
const profileOf = (user: {
  id: bigint;
  email: string;
  themePreference: string;
  role: { name: string };
}) => ({
  id: user.id.toString(),
  email: user.email,
  role: user.role.name as UserRole,
  themePreference: user.themePreference,
});

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/auth/login', async (request) => {
    const { email, password } = parse(loginSchema, request.body);

    const user = await prisma.user.findUnique({ where: { email }, include: { role: true } });
    if (!user || !user.isActive) throw unauthorized();

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized();

    // The JWT stays minimal (id/email/role) so a theme change never requires a new token; the
    // theme travels in the login response body and is refreshable via GET /auth/me.
    const token = app.jwt.sign({ id: user.id.toString(), email: user.email, role: user.role.name as UserRole });
    return { token, user: profileOf(user) };
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request) => {
    const id = BigInt((request.user as { id: string }).id);
    const user = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!user) throw unauthorized();
    return { user: profileOf(user) };
  });

  // Self-service profile update (currently just the UI theme preference), persisted to the DB.
  app.patch('/auth/me', { preHandler: [app.authenticate] }, async (request) => {
    const { themePreference } = parse(updateMeSchema, request.body);
    const id = BigInt((request.user as { id: string }).id);
    const user = await prisma.user.update({
      where: { id },
      data: { themePreference },
      include: { role: true },
    });
    return { user: profileOf(user) };
  });
};
