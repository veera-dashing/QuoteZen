import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Admin user management: add / edit / reset password, plus the lock-out guards. Every user created
 * here uses the `zz-users-<pid>-` email prefix and is deleted afterwards.
 */
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;
let adminId: string;
let roles: Record<string, string>;
const PREFIX = `zz-users-${process.pid}-`;
const mail = (s: string) => `${PREFIX}${s}-${Math.floor(Math.random() * 1e9)}@quotezen.test`;

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const createUser = (payload: Record<string, unknown>, token = adminToken) =>
  app.inject({ method: 'POST', url: '/admin/users', headers: as(token), payload });
const patchUser = (id: string, payload: Record<string, unknown>, token = adminToken) =>
  app.inject({ method: 'PATCH', url: `/admin/users/${id}`, headers: as(token), payload });

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const a = (await login('admin@quotezen.local', 'demo')).json();
  adminToken = a.token as string;
  adminId = a.user.id as string;
  salesToken = (await login('sales@quotezen.local', 'demo')).json().token as string;
  const list = (await app.inject({ method: 'GET', url: '/admin/roles', headers: as(adminToken) })).json() as Array<{
    id: string;
    name: string;
  }>;
  roles = Object.fromEntries(list.map((r) => [r.name, r.id]));
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('add user', () => {
  it('creates a user who can then sign in (email is case-insensitive); the hash is never returned', async () => {
    const email = mail('new');
    const res = await createUser({ name: 'New Person', email: email.toUpperCase(), roleId: roles.sales, password: 'secret-123' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe(email); // stored lower-case
    expect(body.role.name).toBe('sales');
    expect(body).not.toHaveProperty('passwordHash');

    const ok = await login(email.toUpperCase(), 'secret-123');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.role).toBe('sales');
  });

  it('rejects a duplicate email (409), a short password (422) and an unknown role (422)', async () => {
    const email = mail('dup');
    expect((await createUser({ name: 'A', email, roleId: roles.viewer, password: 'secret-123' })).statusCode).toBe(201);
    expect((await createUser({ name: 'B', email, roleId: roles.viewer, password: 'secret-123' })).statusCode).toBe(409);
    expect((await createUser({ name: 'C', email: mail('short'), roleId: roles.viewer, password: 'short' })).statusCode).toBe(422);
    expect((await createUser({ name: 'D', email: mail('role'), roleId: 999999, password: 'secret-123' })).statusCode).toBe(422);
  });

  it('is admin-only', async () => {
    const res = await createUser({ name: 'X', email: mail('sales'), roleId: roles.viewer, password: 'secret-123' }, salesToken);
    expect(res.statusCode).toBe(403);
  });
});

describe('edit user', () => {
  it('edits name / email / role and resets the password (old one stops working); audit never stores it', async () => {
    const email = mail('edit');
    const id = (await createUser({ name: 'Before', email, roleId: roles.viewer, password: 'first-pass' })).json().id as string;

    const newEmail = mail('edited');
    const res = await patchUser(id, { name: 'After', email: newEmail, roleId: roles.manager, password: 'second-pass' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'After', email: newEmail, role: { name: 'manager' } });

    expect((await login(newEmail, 'first-pass')).statusCode).toBe(401);
    expect((await login(newEmail, 'second-pass')).statusCode).toBe(200);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { tableName: 'users', recordId: id, action: 'update' },
      orderBy: { id: 'desc' },
    });
    expect(audit?.changes).toMatchObject({ password: 'reset', role: { old: 'viewer', new: 'manager' } });
    expect(JSON.stringify(audit?.changes)).not.toContain('second-pass');
  });

  it('a deactivated user can no longer sign in', async () => {
    const email = mail('inactive');
    const id = (await createUser({ name: 'Leaver', email, roleId: roles.sales, password: 'secret-123' })).json().id as string;
    expect((await patchUser(id, { isActive: false })).statusCode).toBe(200);
    expect((await login(email, 'secret-123')).statusCode).toBe(401);
  });

  it('rejects an email already used by another user (409)', async () => {
    const taken = mail('taken');
    await createUser({ name: 'One', email: taken, roleId: roles.viewer, password: 'secret-123' });
    const id = (await createUser({ name: 'Two', email: mail('two'), roleId: roles.viewer, password: 'secret-123' })).json()
      .id as string;
    expect((await patchUser(id, { email: taken })).statusCode).toBe(409);
  });

  it('an admin cannot deactivate or demote their own account', async () => {
    expect((await patchUser(adminId, { isActive: false })).statusCode).toBe(403);
    expect((await patchUser(adminId, { roleId: roles.sales })).statusCode).toBe(403);
    // Harmless self-edits still work.
    const me = (await app.inject({ method: 'GET', url: '/admin/users', headers: as(adminToken) })).json() as Array<{
      id: string;
      name: string;
    }>;
    const myName = me.find((u) => u.id === adminId)?.name ?? 'Demo Admin';
    expect((await patchUser(adminId, { name: myName })).statusCode).toBe(200);
  });
});
