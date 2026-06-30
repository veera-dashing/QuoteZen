import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * U3 — client discount applied to pricing. The discount reduces the one-off SELL base
 * (equipment + services); the quote-level discount OVERRIDES the client default; and the margin-floor
 * guardrail is still enforced (a discount breaching the floor needs admin/elevated approval).
 */
const JOB_PREFIX = `DISC-${process.pid}-`;
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

const ledProduct = () =>
  prisma.ledProduct.findFirstOrThrow({
    where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
  });

/** Create a quote with one LED screen, optionally with a quote-level discount + client. */
const newQuoteWithScreen = async (
  headers: Record<string, string>,
  opts: { discountPct?: number; clientId?: number } = {},
) => {
  const product = await ledProduct();
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers,
    payload: {
      jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`,
      currencyCode: 'AUD',
      ...(opts.discountPct !== undefined ? { discountPct: opts.discountPct } : {}),
      ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
    },
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers,
    payload: { ledProductId: Number(product.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  return id;
};

const priceOf = async (id: string, headers: Record<string, string>) =>
  (await app.inject({ method: 'POST', url: `/quotes/${id}/price`, headers })).json() as {
    discount?: { pct: number; source: string; amount: string };
    totals: { equipment: string; services: string; grandTotal: string; margin: string | null };
  };

describe('U3 — discount reduces the grand total', () => {
  it('a quote.discountPct reduces grandTotal by pct × (equipment + services)', async () => {
    // baseline: no discount
    const base = await newQuoteWithScreen(admin());
    const basePrice = await priceOf(base, admin());
    const baseGrand = Number(basePrice.totals.grandTotal);
    expect(baseGrand).toBeGreaterThan(0);
    expect(basePrice.discount?.pct ?? 0).toBe(0);

    // 10% discount
    const disc = await newQuoteWithScreen(admin(), { discountPct: 0.1 });
    const discPrice = await priceOf(disc, admin());
    expect(discPrice.discount?.source).toBe('quote');
    expect(discPrice.discount?.pct).toBe(0.1);

    // discounted grand = base grand (same screen) − 10%
    const upfront = Number(discPrice.totals.equipment) + Number(discPrice.totals.services);
    const expectedAmount = Math.round(upfront * 0.1 * 100) / 100;
    expect(Number(discPrice.discount?.amount)).toBeCloseTo(expectedAmount, 1);
    expect(Number(discPrice.totals.grandTotal)).toBeCloseTo(baseGrand * 0.9, 0);
  });

  it('quote-level discount OVERRIDES the client default', async () => {
    // a client carrying a 5% discount
    const client = await prisma.client.create({
      data: { name: `${JOB_PREFIX}client-${Math.floor(Math.random() * 1e9)}`, discountPct: 0.05 },
    });

    // quote with this client but NO quote-level override → client discount applies
    const clientOnly = await newQuoteWithScreen(admin(), { clientId: Number(client.id) });
    const clientPrice = await priceOf(clientOnly, admin());
    expect(clientPrice.discount?.source).toBe('client');
    expect(clientPrice.discount?.pct).toBe(0.05);

    // quote with this client AND a 20% quote override → quote wins
    const overridden = await newQuoteWithScreen(admin(), { clientId: Number(client.id), discountPct: 0.2 });
    const ovPrice = await priceOf(overridden, admin());
    expect(ovPrice.discount?.source).toBe('quote');
    expect(ovPrice.discount?.pct).toBe(0.2);

    await prisma.quote.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });
});

describe('U3 — discount lowers margin → margin-floor guardrail', () => {
  it('a large discount blocks non-admin finalisation (403) but admin can override (audited)', async () => {
    // Set a moderate floor; the screen by itself clears it, but a deep discount drops below it.
    await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } });

    // sales quote with a 90% discount → margin tanks below the floor
    const blockedId = await newQuoteWithScreen(sales(), { discountPct: 0.9 });
    const blocked = await app.inject({
      method: 'POST',
      url: `/quotes/${blockedId}/status`,
      headers: sales(),
      payload: { status: 'approved' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/below the floor/);

    // admin can override the same deep discount (audited)
    const adminId = await newQuoteWithScreen(admin(), { discountPct: 0.9 });
    const allowed = await app.inject({
      method: 'POST',
      url: `/quotes/${adminId}/status`,
      headers: admin(),
      payload: { status: 'approved' },
    });
    expect(allowed.statusCode).toBe(200);

    const audit = await app.inject({ method: 'GET', url: `/quotes/${adminId}/audit`, headers: admin() });
    expect(
      (audit.json() as Array<{ fieldName: string | null }>).some((a) => a.fieldName === 'margin_guardrail'),
    ).toBe(true);

    await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } });
  });
});

describe('U3 — /rules/client/:id/effective surfaces the discount', () => {
  it('reports the client discount (value + source: client override vs system default)', async () => {
    const client = await prisma.client.create({
      data: { name: `${JOB_PREFIX}rules-${Math.floor(Math.random() * 1e9)}`, discountPct: 0.07 },
    });
    const res = await app.inject({ method: 'GET', url: `/rules/client/${client.id}/effective`, headers: admin() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { discount: { value: number; source: string; overridesGlobal: boolean } };
    expect(body.discount.value).toBe(0.07);
    expect(body.discount.source).toBe('client');
    expect(body.discount.overridesGlobal).toBe(true);

    // a client without a discount falls back to the system default
    const plain = await prisma.client.create({
      data: { name: `${JOB_PREFIX}rules2-${Math.floor(Math.random() * 1e9)}` },
    });
    const res2 = await app.inject({ method: 'GET', url: `/rules/client/${plain.id}/effective`, headers: admin() });
    const body2 = res2.json() as { discount: { source: string; overridesGlobal: boolean } };
    expect(body2.discount.source).toBe('system');
    expect(body2.discount.overridesGlobal).toBe(false);

    await prisma.client.deleteMany({ where: { id: { in: [client.id, plain.id] } } });
  });
});
