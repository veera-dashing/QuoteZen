import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Quote-level discount guardrail (A+): the discount override is CAPPED at 12% (a non-admin is blocked
 * above it; an admin may exceed it, audited) and any discount above 5% requires a manager note.
 */
const JOB_PREFIX = `DGUARD-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;
const admin = () => ({ authorization: `Bearer ${adminToken}` });
const sales = () => ({ authorization: `Bearer ${salesToken}` });

const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json()
    .token as string;

const ref = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;
const create = (headers: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/quotes', headers, payload: { jobReference: ref(), currencyCode: 'AUD', ...body } });

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
  salesToken = await login('sales@quotezen.local');
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('discount cap (12%)', () => {
  it('blocks a non-admin above the cap (403)', async () => {
    const res = await create(sales(), { discountPct: 0.15, discountNote: 'strategic account' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/cap/i);
  });

  it('lets an admin exceed the cap and audits the override', async () => {
    const res = await create(admin(), { discountPct: 0.15, discountNote: 'exec-approved' });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const audit = await app.inject({ method: 'GET', url: `/quotes/${id}/audit`, headers: admin() });
    const rows = audit.json() as Array<{ fieldName: string | null; newValue: string | null }>;
    expect(rows.some((r) => r.fieldName === 'discount_guardrail' && /cap override/i.test(r.newValue ?? ''))).toBe(true);
  });
});

describe('note required above 5%', () => {
  it('rejects a >5% discount with no note (422)', async () => {
    const res = await create(sales(), { discountPct: 0.08 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/manager note/i);
  });

  it('accepts a >5% discount with a note (201)', async () => {
    const res = await create(sales(), { discountPct: 0.08, discountNote: 'competitive tender' });
    expect(res.statusCode).toBe(201);
  });

  it('allows a <=5% discount with no note (201)', async () => {
    const res = await create(sales(), { discountPct: 0.05 });
    expect(res.statusCode).toBe(201);
  });
});

describe('update path enforces the same rules', () => {
  it('blocks raising the discount above 5% without a note, then allows it with one', async () => {
    const created = await create(sales(), { discountPct: 0.03 });
    const id = created.json().id as string;
    const v = created.json().lockVersion as number;

    const noNote = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: sales(),
      payload: { discountPct: 0.09, expectedVersion: v },
    });
    expect(noNote.statusCode).toBe(422);

    const withNote = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: sales(),
      payload: { discountPct: 0.09, discountNote: 'volume deal', expectedVersion: v },
    });
    expect(withNote.statusCode).toBe(200);
  });
});
