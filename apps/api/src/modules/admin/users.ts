import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { notFound } from '../../errors.js';
import { parse } from '../../lib/validate.js';

/**
 * RBAC user/role management (P1-19g.1). Admin-only. Passwords are never exposed or settable here.
 */
const idParam = z.object({ id: z.coerce.bigint() });
const updateUserSchema = z
  .object({ roleId: z.coerce.number().int().positive().optional(), isActive: z.boolean().optional() })
  .refine((v) => v.roleId !== undefined || v.isActive !== undefined, { message: 'nothing to update' });

const PUBLIC_USER = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
} as const;

export const userRoutes = async (app: FastifyInstance): Promise<void> => {
  const adminOnly = { preHandler: [app.requireRole('admin')] };

  app.get('/admin/users', adminOnly, () =>
    prisma.user.findMany({ select: PUBLIC_USER, orderBy: { email: 'asc' } }),
  );

  app.get('/admin/roles', adminOnly, () => prisma.role.findMany({ orderBy: { name: 'asc' } }));

  app.patch<{ Params: { id: string } }>('/admin/users/:id', adminOnly, async (request) => {
    const { id } = parse(idParam, request.params);
    const data = parse(updateUserSchema, request.body);
    try {
      return await prisma.user.update({
        where: { id },
        data: { roleId: data.roleId ? BigInt(data.roleId) : undefined, isActive: data.isActive },
        select: PUBLIC_USER,
      });
    } catch {
      throw notFound('User', id.toString());
    }
  });
};
