import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * U5 — discount scope. A discount can be a `one_off` upfront concession (default: reduces the
 * equipment + services grandTotal; recurring untouched) or apply to `recurring` (every renewal:
 * reduces the recurring total; the upfront/grandTotal upfront portion is untouched). A recurring-scope
 * discount must NOT lower the one-off margin, so it must NOT trip the one-off margin-floor guardrail.
 */
const JOB_PREFIX = `U5-${process.pid}-`;
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
  // Lift the discount CAP so the deep discounts these scope tests use are creatable (the cap itself
  // is covered by discount-guardrail.test.ts).
  await prisma.setting.update({ where: { key: 'discount_cap_pct' }, data: { value: 1 } }).catch(() => undefined);
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } }).catch(() => undefined);
  await prisma.setting.update({ where: { key: 'discount_cap_pct' }, data: { value: 0.12 } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

// Coarse pitch (>= 2.5mm) so the screen needs no GOB — keeps it validation-clean, isolating the
// margin-floor behaviour from the validation guardrail (a fine-pitch screen would flag GOB_REQUIRED
// and block finalisation regardless of the discount).
const ledProduct = () =>
  prisma.ledProduct.findFirstOrThrow({
    where: { minCabinetWMm: { not: null }, pixelPitchH: { gte: 2.5 }, costPerSqmUsd: { not: null } },
  });

/** Create a quote with one LED screen + one recurring music line, with a discount + scope. */
const newQuote = async (
  headers: Record<string, string>,
  opts: { discountPct?: number; discountScope?: 'one_off' | 'recurring' } = {},
) => {
  const product = await ledProduct();
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers,
    payload: {
      jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`,
      currencyCode: 'AUD',
      ...(opts.discountPct !== undefined ? { discountPct: opts.discountPct, discountNote: 'test justification' } : {}),
      ...(opts.discountScope !== undefined ? { discountScope: opts.discountScope } : {}),
    },
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers,
    payload: { ledProductId: Number(product.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  // Attach a recurring music line so the recurring total is non-zero (to test recurring-scope).
  const music = await prisma.musicService.findFirst({ where: { sell: { gt: 0 } } });
  if (music) {
    await prisma.quoteMusicItem.create({
      data: { quoteId: BigInt(id), musicServiceId: music.id, qty: 1 },
    });
    await app.inject({ method: 'POST', url: `/quotes/${id}/recompute`, headers });
  }
  return id;
};

const priceOf = async (id: string, headers: Record<string, string>) =>
  (await app.inject({ method: 'POST', url: `/quotes/${id}/price`, headers })).json() as {
    discount?: { pct: number; source: string; scope: string; amount: string };
    totals: { equipment: string; services: string; recurring: string; grandTotal: string; margin: string | null };
  };

describe('U5 — discount scope applies to the elected base', () => {
  it('one_off (default) reduces the upfront grandTotal; recurring is unchanged', async () => {
    const base = await newQuote(admin());
    const basePrice = await priceOf(base, admin());
    const baseGrand = Number(basePrice.totals.grandTotal);
    const baseRecurring = Number(basePrice.totals.recurring);
    expect(baseGrand).toBeGreaterThan(0);
    expect(basePrice.discount?.scope).toBe('one_off'); // default scope

    const disc = await newQuote(admin(), { discountPct: 0.1, discountScope: 'one_off' });
    const dp = await priceOf(disc, admin());
    expect(dp.discount?.scope).toBe('one_off');
    const upfront = Number(dp.totals.equipment) + Number(dp.totals.services);
    // grandTotal discounted ~10%; recurring untouched (same as baseline).
    expect(Number(dp.totals.grandTotal)).toBeCloseTo(baseGrand * 0.9, 0);
    expect(Number(dp.totals.recurring)).toBeCloseTo(baseRecurring, 1);
    expect(Number(dp.discount?.amount)).toBeCloseTo(Math.round(upfront * 0.1 * 100) / 100, 1);
  });

  it('recurring reduces the recurring total; the upfront grandTotal is unchanged', async () => {
    const base = await newQuote(admin());
    const basePrice = await priceOf(base, admin());
    const baseGrand = Number(basePrice.totals.grandTotal);
    const baseRecurring = Number(basePrice.totals.recurring);
    expect(baseRecurring).toBeGreaterThan(0); // a music line is attached

    const disc = await newQuote(admin(), { discountPct: 0.1, discountScope: 'recurring' });
    const dp = await priceOf(disc, admin());
    expect(dp.discount?.scope).toBe('recurring');
    // recurring discounted ~10%; upfront grandTotal untouched (same as baseline).
    expect(Number(dp.totals.recurring)).toBeCloseTo(baseRecurring * 0.9, 1);
    expect(Number(dp.totals.grandTotal)).toBeCloseTo(baseGrand, 0);
    expect(Number(dp.discount?.amount)).toBeCloseTo(Math.round(baseRecurring * 0.1 * 100) / 100, 1);
  });
});

describe('U5 — recurring-scope discount does NOT trip the one-off margin floor', () => {
  it('a 90% recurring discount lets a non-admin finalise (vs one_off which is blocked)', async () => {
    // Z3: the two-tier margin guardrail (min-gross 28% / walk-away 22%) now gates finalisation, not
    // `margin_floor`. one_off 90% → margin tanks below 22% → non-admin blocked (sanity check the gate).
    const blockedId = await newQuote(sales(), { discountPct: 0.9, discountScope: 'one_off' });
    const blocked = await app.inject({
      method: 'POST',
      url: `/quotes/${blockedId}/status`,
      headers: sales(),
      payload: { status: 'approved' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/walk-away floor. Director approval required/);

    // recurring 90% → upfront sell (and one-off margin) untouched → non-admin can finalise.
    const okId = await newQuote(sales(), { discountPct: 0.9, discountScope: 'recurring' });
    const ok = await app.inject({
      method: 'POST',
      url: `/quotes/${okId}/status`,
      headers: sales(),
      payload: { status: 'approved' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
