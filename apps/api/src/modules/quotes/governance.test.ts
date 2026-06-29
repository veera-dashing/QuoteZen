import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/** Versioning (P1-04), margin guardrail (P1-19g.2) and RBAC user management (P1-19g.1). */
const JOB_PREFIX = `GOV-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;
const admin = () => ({ authorization: `Bearer ${adminToken}` });
const sales = () => ({ authorization: `Bearer ${salesToken}` });

const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json()
    .token as string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
  salesToken = await login('sales@quotezen.local');
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

const newQuoteWithScreen = async (headers: Record<string, string>) => {
  const product = await prisma.ledProduct.findFirst({
    where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
  });
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers,
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers,
    payload: { ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  return id;
};

describe('versioning & snapshots', () => {
  it('captures, lists, diffs and rolls back versions (history preserved)', async () => {
    const id = await newQuoteWithScreen(admin());

    const v1 = await app.inject({ method: 'POST', url: `/quotes/${id}/versions`, headers: admin(), payload: { label: 'v1' } });
    expect(v1.statusCode).toBe(201);
    expect(v1.json().revisionNo).toBe(1);

    // change something, snapshot again
    await app.inject({ method: 'PATCH', url: `/quotes/${id}`, headers: admin(), payload: { resellerMarkup: 0.15 } });
    const v2 = await app.inject({ method: 'POST', url: `/quotes/${id}/versions`, headers: admin(), payload: { label: 'v2' } });
    expect(v2.json().revisionNo).toBe(2);

    const list = await app.inject({ method: 'GET', url: `/quotes/${id}/versions`, headers: admin() });
    expect((list.json() as unknown[]).length).toBe(2);

    const diff = await app.inject({ method: 'GET', url: `/quotes/${id}/versions/diff?a=1&b=2`, headers: admin() });
    expect(diff.statusCode).toBe(200);
    expect((diff.json() as Array<{ path: string }>).some((d) => d.path.includes('resellerMarkup'))).toBe(true);

    // rollback to v1 → creates a new version (history not destroyed)
    const rb = await app.inject({ method: 'POST', url: `/quotes/${id}/versions/1/rollback`, headers: admin() });
    expect(rb.statusCode).toBe(201);
    expect(rb.json().revisionNo).toBe(3);
    expect(rb.json().restoredFrom).toBe(1);
  });
});

describe('margin guardrail', () => {
  it('blocks below-floor finalisation for non-admin, allows admin override (audited)', async () => {
    await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.99 } }); // force below-floor
    const id = await newQuoteWithScreen(sales());

    const blocked = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: sales(), payload: { status: 'approved' } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/below the floor/);

    // admin can override (different quote of their own, floor still 0.99)
    const adminId = await newQuoteWithScreen(admin());
    const allowed = await app.inject({ method: 'POST', url: `/quotes/${adminId}/status`, headers: admin(), payload: { status: 'approved' } });
    expect(allowed.statusCode).toBe(200);

    const audit = await app.inject({ method: 'GET', url: `/quotes/${adminId}/audit`, headers: admin() });
    expect((audit.json() as Array<{ fieldName: string | null }>).some((a) => a.fieldName === 'margin_guardrail')).toBe(true);

    await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } });
  });
});

describe('optimistic concurrency (P1-05.2)', () => {
  it('rejects a stale write with 409 instead of last-write-wins', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: admin(),
      payload: { jobReference: `${JOB_PREFIX}lock-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    expect(created.json().lockVersion).toBe(0);

    // first edit with the known version succeeds and bumps the token
    const ok = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: admin(),
      payload: { resellerMarkup: 0.05, expectedVersion: 0 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().lockVersion).toBe(1);

    // a second edit still using version 0 is a conflict
    const stale = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: admin(),
      payload: { resellerMarkup: 0.09, expectedVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');
  });
});

describe('client rule resolution (P1-10)', () => {
  it('merges global + client margin with guardrail winning below the floor', async () => {
    const client = await prisma.client.findFirstOrThrow();
    await prisma.client.update({ where: { id: client.id }, data: { defaultMargin: 0.1, preferredProductFamily: 'BM-PRO' } });

    const res = await app.inject({ method: 'GET', url: `/rules/client/${client.id}/effective`, headers: admin() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      margin: { value: number; source: string; floor: number; belowFloor: boolean; effective: number };
      preferredProductFamily: { value: string | null; overridesGlobal: boolean };
    };
    expect(body.margin.source).toBe('client');
    expect(body.margin.belowFloor).toBe(true);
    expect(body.margin.effective).toBe(0.2); // guardrail (floor) wins over the 0.1 client margin
    expect(body.preferredProductFamily.value).toBe('BM-PRO');
    expect(body.preferredProductFamily.overridesGlobal).toBe(true);

    await prisma.client.update({ where: { id: client.id }, data: { defaultMargin: null, preferredProductFamily: null } });
  });
});

describe('named-ratio description (refinement)', () => {
  it('uses the named screen ratio (9:16) not the raw gcd', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null } },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: admin(),
      payload: { jobReference: `${JOB_PREFIX}ratio-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/quotes/${id}/led-screens`,
      headers: admin(),
      payload: { ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });
    const desc = await app.inject({ method: 'GET', url: `/quotes/${id}/descriptions`, headers: admin() });
    expect((desc.json() as Array<{ description: string }>)[0]!.description).toContain('9:16 ratio');
  });
});

describe('KB capture (P1-19f)', () => {
  it('captures a completed quote into the knowledge base on issue', async () => {
    const id = await newQuoteWithScreen(admin());
    const issued = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: admin(), payload: { status: 'issued' } });
    expect(issued.statusCode).toBe(200);

    const kb = await app.inject({ method: 'GET', url: '/kb', headers: admin() });
    expect(kb.statusCode).toBe(200);
    const entries = kb.json() as Array<{ jobReference: string; outcome: string; screenCount: number }>;
    const mine = entries.find((e) => e.jobReference.startsWith(JOB_PREFIX));
    expect(mine).toBeTruthy();
    expect(mine!.outcome).toBe('issued');
    expect(mine!.screenCount).toBeGreaterThanOrEqual(1);

    // KB holds sensitive history → sales allowed, viewers/anon are not (sales is allowed here).
    const salesKb = await app.inject({ method: 'GET', url: '/kb', headers: sales() });
    expect(salesKb.statusCode).toBe(200);
  });
});

describe('audit viewer (P1-03.3)', () => {
  it('admin can read the cross-quote feed and filter; sales is forbidden', async () => {
    const all = await app.inject({ method: 'GET', url: '/admin/audit?action=status_change', headers: admin() });
    expect(all.statusCode).toBe(200);
    const rows = all.json() as Array<{ action: string; quote: { jobReference: string } }>;
    expect(rows.every((r) => r.action === 'status_change')).toBe(true);
    expect(rows[0]).toHaveProperty('quote');

    const forbidden = await app.inject({ method: 'GET', url: '/admin/audit', headers: sales() });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('RBAC user management', () => {
  it('admin can list users; sales is forbidden', async () => {
    const adminList = await app.inject({ method: 'GET', url: '/admin/users', headers: admin() });
    expect(adminList.statusCode).toBe(200);
    const users = adminList.json() as Array<{ email: string; passwordHash?: string }>;
    expect(users.length).toBeGreaterThan(0);
    expect(users[0]).not.toHaveProperty('passwordHash'); // never exposed

    const salesList = await app.inject({ method: 'GET', url: '/admin/users', headers: sales() });
    expect(salesList.statusCode).toBe(403);
  });
});
