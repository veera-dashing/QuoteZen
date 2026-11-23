import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { loginSchema, updateMeSchema } from '@quotezen/shared';
import type { UserRole } from '@quotezen/shared';
import { AppError, unauthorized } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { recordAdminAudit } from '../../services/audit.js';
import { MIN_PASSWORD_LENGTH } from '../admin/users.js';

/** Self-service password change. */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'current password is required'),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `new password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

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

    // Emails are stored lower-case (admin user management normalises them), so match case-insensitively.
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: { role: true } });
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

  // Self-service password change: any signed-in user, after re-entering their current password.
  // A wrong current password is a 422, NOT a 401 — the web client treats any 401 as "session expired"
  // and would sign the user out.
  app.post('/auth/change-password', { preHandler: [app.authenticate] }, async (request) => {
    const { currentPassword, newPassword } = parse(changePasswordSchema, request.body);
    const id = BigInt((request.user as { id: string }).id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || !user.isActive) throw unauthorized();

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError('validation_error', 'Current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw new AppError('validation_error', 'New password must be different from the current one');
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash } });
      // Recorded as a flag only — the password itself is never logged.
      await recordAdminAudit(tx, {
        userId: id,
        tableName: 'users',
        recordId: id.toString(),
        action: 'update',
        changes: { password: 'changed by user' },
      });
    });
    return { ok: true };
  });
};
