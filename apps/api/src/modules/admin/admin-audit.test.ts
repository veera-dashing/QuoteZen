import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * High-sensitivity admin surface (P1-06.6 / P1-07.6 / P1-07.2):
 *   • generic CRUD writes an AdminAuditLog row with the right diff,
 *   • GET/PATCH /admin/margins reads + bulk-updates settings and audits,
 *   • export writes an 'export' audit row.
 */
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { name: { startsWith: 'ZZ-AUDIT-' } } });
  await app.close();
  await prisma.$disconnect();
});

const adminAuditFor = (resource: string, recordId: string) =>
  prisma.adminAuditLog.findMany({ where: { tableName: resource, recordId }, orderBy: { id: 'asc' } });

describe('admin CRUD writes AdminAuditLog rows', () => {
  it('records create, update (diff) and delete (prior values)', async () => {
    const name = `ZZ-AUDIT-${Math.floor(Math.random() * 1e9)}`;

    const created = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: auth(),
      payload: { name, marginNote: 'before' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const afterCreate = await adminAuditFor('clients', id);
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]?.action).toBe('create');
    expect((afterCreate[0]?.changes as Record<string, unknown>)?.name).toBe(name);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${id}`,
      headers: auth(),
      payload: { marginNote: 'after' },
    });
    expect(patched.statusCode).toBe(200);

    const afterUpdate = await adminAuditFor('clients', id);
    expect(afterUpdate).toHaveLength(2);
    const upd = afterUpdate[1];
    expect(upd?.action).toBe('update');
    const diff = upd?.changes as Record<string, { old: string; new: string }>;
    expect(diff.marginNote).toEqual({ old: 'before', new: 'after' });

    const del = await app.inject({ method: 'DELETE', url: `/admin/clients/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);

    const afterDelete = await adminAuditFor('clients', id);
    expect(afterDelete).toHaveLength(3);
    const dele = afterDelete[2];
    expect(dele?.action).toBe('delete');
    expect((dele?.changes as Record<string, unknown>)?.marginNote).toBe('after');
  });
});

describe('GET/PATCH /admin/margins', () => {
  it('reads the margin rows and bulk-updates with audit', async () => {
    const get = await app.inject({ method: 'GET', url: '/admin/margins', headers: auth() });
    expect(get.statusCode).toBe(200);
    const rows = get.json() as Array<{ key: string; value: string }>;
    const floor = rows.find((r) => r.key === 'margin_floor');
    expect(floor).toBeTruthy();
    const original = floor!.value;

    const bumped = (Number(original) + 0.01).toFixed(2);
    const before = await prisma.adminAuditLog.count({ where: { tableName: 'settings', action: 'update' } });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/admin/margins',
      headers: auth(),
      payload: { values: { margin_floor: Number(bumped) } },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json() as Array<{ key: string; value: string }>;
    expect(Number(updated.find((r) => r.key === 'margin_floor')!.value)).toBeCloseTo(Number(bumped), 4);

    const after = await prisma.adminAuditLog.count({ where: { tableName: 'settings', action: 'update' } });
    expect(after).toBe(before + 1);

    // Restore the original value (also audited — keeps the DB stable for other suites).
    await app.inject({
      method: 'PATCH',
      url: '/admin/margins',
      headers: auth(),
      payload: { values: { margin_floor: Number(original) } },
    });
  });

  it('rejects an unknown margin key', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/margins',
      headers: auth(),
      payload: { values: { not_a_real_key: 1 } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('export writes an export audit row', () => {
  it('records who exported what', async () => {
    const before = await prisma.adminAuditLog.count({ where: { tableName: 'settings', action: 'export' } });
    const res = await app.inject({ method: 'GET', url: '/admin/settings/export', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const after = await prisma.adminAuditLog.count({ where: { tableName: 'settings', action: 'export' } });
    expect(after).toBe(before + 1);
  });
});

describe('admin-audit viewer', () => {
  it('lists reference-table audit events (admin only)', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/admin-audit?action=export', headers: auth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ action: string }>;
    expect(rows.every((r) => r.action === 'export')).toBe(true);
  });
});
