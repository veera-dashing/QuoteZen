import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { AppError, conflict, notFound } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { recordAdminAudit } from '../../services/audit.js';

/**
 * RBAC user management (P1-19g.1). Admin-only: list, add, edit (name / email / role / active) and
 * reset a password. Password hashes are never returned, and passwords never appear in the audit log.
 *
 * Lock-out guards: an admin cannot deactivate or demote themselves, and the last active admin can
 * never be deactivated or demoted — otherwise nobody could manage users any more.
 */
const idParam = z.object({ id: z.coerce.bigint() });

/** Emails are stored trimmed + lower-case so login is case-insensitive. */
const email = z.string().trim().toLowerCase().email();
const name = z.string().trim().min(1, 'name is required');
/** Minimum password length for accounts created or reset here. */
export const MIN_PASSWORD_LENGTH = 8;
const password = z.string().min(MIN_PASSWORD_LENGTH, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);

const createUserSchema = z.object({
  name,
  email,
  roleId: z.coerce.number().int().positive(),
  password,
  isActive: z.boolean().optional(),
});

const updateUserSchema = z
  .object({
    name: name.optional(),
    email: email.optional(),
    roleId: z.coerce.number().int().positive().optional(),
    isActive: z.boolean().optional(),
    password: password.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'nothing to update' });

const PUBLIC_USER = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
} as const;

const BCRYPT_ROUNDS = 10;

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

export const userRoutes = async (app: FastifyInstance): Promise<void> => {
  const adminOnly = { preHandler: [app.requireRole('admin')] };

  const roleById = async (roleId: number) => {
    const role = await prisma.role.findUnique({ where: { id: BigInt(roleId) } });
    if (!role) throw new AppError('validation_error', `role ${roleId} does not exist`);
    return role;
  };

  app.get('/admin/users', adminOnly, () =>
    prisma.user.findMany({ select: PUBLIC_USER, orderBy: { email: 'asc' } }),
  );

  app.get('/admin/roles', adminOnly, () => prisma.role.findMany({ orderBy: { name: 'asc' } }));

  // Active viewer users a quote can be shared with (writers need this for the assignment picker).
  app.get('/users/viewers', { preHandler: [app.requireRole('admin', 'sales', 'director', 'manager')] }, () =>
    prisma.user.findMany({
      where: { isActive: true, role: { name: 'viewer' } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    }),
  );

  // ── Add a user ──
  app.post('/admin/users', adminOnly, async (request, reply) => {
    const data = parse(createUserSchema, request.body);
    const role = await roleById(data.roleId);
    const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: data.name,
            email: data.email,
            roleId: role.id,
            isActive: data.isActive ?? true,
            passwordHash,
          },
          select: PUBLIC_USER,
        });
        await recordAdminAudit(tx, {
          userId: BigInt(request.user.id),
          tableName: 'users',
          recordId: user.id.toString(),
          action: 'create',
          changes: { name: user.name, email: user.email, role: role.name, isActive: user.isActive },
        });
        return user;
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A user with email ${data.email} already exists`);
      throw err;
    }
  });

  // ── Edit a user (any of name / email / role / active, or reset the password) ──
  app.patch<{ Params: { id: string } }>('/admin/users/:id', adminOnly, async (request) => {
    const { id } = parse(idParam, request.params);
    const data = parse(updateUserSchema, request.body);
    const before = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!before) throw notFound('User', id.toString());

    const newRole = data.roleId !== undefined ? await roleById(data.roleId) : before.role;
    const deactivating = data.isActive === false && before.isActive;
    const demoting = before.role.name === 'admin' && newRole.name !== 'admin';

    // Lock-out guards.
    const isSelf = id.toString() === request.user.id;
    if (isSelf && (deactivating || demoting)) {
      throw new AppError('forbidden', 'You cannot deactivate or remove the admin role from your own account');
    }
    if (before.isActive && before.role.name === 'admin' && (deactivating || demoting)) {
      const activeAdmins = await prisma.user.count({ where: { isActive: true, role: { name: 'admin' } } });
      if (activeAdmins <= 1) throw new AppError('forbidden', 'At least one active admin must remain');
    }

    const passwordHash = data.password ? await bcrypt.hash(data.password, BCRYPT_ROUNDS) : undefined;
    try {
      return await prisma.$transaction(async (tx) => {
        const after = await tx.user.update({
          where: { id },
          data: {
            name: data.name,
            email: data.email,
            roleId: data.roleId !== undefined ? newRole.id : undefined,
            isActive: data.isActive,
            passwordHash,
          },
          select: PUBLIC_USER,
        });
        // Changed fields only; a password reset is recorded as a flag, never the value.
        const changes: Record<string, unknown> = {};
        if (after.name !== before.name) changes.name = { old: before.name, new: after.name };
        if (after.email !== before.email) changes.email = { old: before.email, new: after.email };
        if (after.role.name !== before.role.name) changes.role = { old: before.role.name, new: after.role.name };
        if (after.isActive !== before.isActive) changes.isActive = { old: before.isActive, new: after.isActive };
        if (passwordHash) changes.password = 'reset';
        await recordAdminAudit(tx, {
          userId: BigInt(request.user.id),
          tableName: 'users',
          recordId: id.toString(),
          action: 'update',
          changes,
        });
        return after;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A user with email ${data.email ?? ''} already exists`);
      throw err;
    }
  });
};
