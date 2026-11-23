import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Self-service password change (POST /auth/change-password). Each test uses a throwaway user with the
 * `zz-pw-<pid>-` email prefix, deleted afterwards — the shared demo accounts are never touched.
 */
let app: FastifyInstance;
const PREFIX = `zz-pw-${process.pid}-`;

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

/** Create a throwaway sales user and return their email + a signed-in token. */
const freshUser = async (password = 'start-pass-1') => {
  const email = `${PREFIX}${Math.floor(Math.random() * 1e9)}@quotezen.test`;
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'sales' } });
  await prisma.user.create({
    data: { email, name: 'PW Test', roleId: role.id, passwordHash: await bcrypt.hash(password, 10) },
  });
  const token = (await login(email, password)).json().token as string;
  return { email, token };
};

const change = (token: string | null, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/auth/change-password',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });

beforeAll(async () => {
  app = await buildApp(loadConfig());
});

afterAll(async () => {
  // A self-service change writes an audit row owned by the test user (FK RESTRICT) — remove it first.
  await prisma.adminAuditLog.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('POST /auth/change-password', () => {
  it('changes the password: the old one stops working, the new one signs in; audit has no password', async () => {
    const { email, token } = await freshUser();
    const res = await change(token, { currentPassword: 'start-pass-1', newPassword: 'brand-new-2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect((await login(email, 'start-pass-1')).statusCode).toBe(401);
    expect((await login(email, 'brand-new-2')).statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const audit = await prisma.adminAuditLog.findFirst({
      where: { tableName: 'users', recordId: user.id.toString() },
      orderBy: { id: 'desc' },
    });
    expect(audit?.changes).toEqual({ password: 'changed by user' });
    expect(JSON.stringify(audit?.changes)).not.toContain('brand-new-2');
  });

  it('a wrong current password is a 422 (not 401, which would sign the user out) and changes nothing', async () => {
    const { email, token } = await freshUser();
    const res = await change(token, { currentPassword: 'wrong-pass', newPassword: 'brand-new-2' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/current password is incorrect/i);
    expect((await login(email, 'start-pass-1')).statusCode).toBe(200);
  });

  it('rejects a too-short new password and an unchanged password (422)', async () => {
    const { token } = await freshUser();
    expect((await change(token, { currentPassword: 'start-pass-1', newPassword: 'short' })).statusCode).toBe(422);
    expect((await change(token, { currentPassword: 'start-pass-1', newPassword: 'start-pass-1' })).statusCode).toBe(422);
  });

  it('requires being signed in (401)', async () => {
    expect((await change(null, { currentPassword: 'x', newPassword: 'brand-new-2' })).statusCode).toBe(401);
  });
});
