import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA3b — LCD Good/Better/Best tiering. `POST /quotes/:id/lcd-options` returns value/recommended/premium
 * display picks over the live catalogue; cost + margin are masked (null) for non-admin (BR-081) and
 * present for admin. Deterministic, no persistence. Self-cleaning by job-reference prefix.
 */
const JOB_PREFIX = `TESTAA3B-${process.pid}-`;
let app: FastifyInstance;
let salesToken: string;
let adminToken: string;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

interface TierOption {
  tier: 'value' | 'recommended' | 'premium';
  label: string;
  rationale: string;
  displayId: string;
  model: string;
  brand: string | null;
  sizeIn: number | null;
  sellAud: string;
  costAud: string | null;
  margin: string | null;
}
interface OptionsResp { options: TierOption[]; reasons: string[]; distinctProducts: number }

const seedQuote = async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: bearer(salesToken),
    payload: { jobReference: jobRef(), currencyCode: 'AUD', resellerMarkup: 0 },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
};

const lcdOptions = async (id: string, token: string, body: Record<string, unknown> = {}): Promise<OptionsResp> => {
  const res = await app.inject({
    method: 'POST',
    url: `/quotes/${id}/lcd-options`,
    headers: bearer(token),
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as OptionsResp;
};

let quoteId: string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  salesToken = await login('sales@quotezen.local');
  adminToken = await login('admin@quotezen.local');
  quoteId = await seedQuote();
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('AA3b — LCD Good/Better/Best options', () => {
  it('returns value/recommended/premium tiers with distinct-ish displays', async () => {
    const resp = await lcdOptions(quoteId, adminToken);
    expect(resp.options.length).toBeGreaterThanOrEqual(2);
    expect(resp.options.map((o) => o.tier)).toEqual(['value', 'recommended', 'premium'].slice(0, resp.options.length));
    // value = cheapest sell, premium = dearest sell.
    const value = resp.options.find((o) => o.tier === 'value')!;
    const premium = resp.options.find((o) => o.tier === 'premium')!;
    expect(Number(value.sellAud)).toBeLessThanOrEqual(Number(premium.sellAud));
    // At least two distinct products where the catalogue allows.
    expect(resp.distinctProducts).toBeGreaterThanOrEqual(2);
    const ids = new Set(resp.options.map((o) => o.displayId));
    expect(ids.size).toBe(resp.distinctProducts);
  });

  it('cost + margin are null for a sales (non-admin) token (BR-081)', async () => {
    const resp = await lcdOptions(quoteId, salesToken);
    expect(resp.options.length).toBeGreaterThan(0);
    for (const o of resp.options) {
      expect(o.costAud).toBeNull();
      expect(o.margin).toBeNull();
      // Sell is always visible.
      expect(Number(o.sellAud)).toBeGreaterThan(0);
    }
  });

  it('cost + margin are present for an admin token (BR-081)', async () => {
    const resp = await lcdOptions(quoteId, adminToken);
    expect(resp.options.length).toBeGreaterThan(0);
    for (const o of resp.options) {
      expect(o.costAud).not.toBeNull();
      expect(o.margin).not.toBeNull();
      expect(Number(o.costAud)).toBeGreaterThanOrEqual(0);
    }
  });

  it('honours a targetSizeIn (recommended is closest available size)', async () => {
    const resp = await lcdOptions(quoteId, adminToken, { targetSizeIn: 55 });
    expect(resp.options.length).toBeGreaterThan(0);
    const rec = resp.options.find((o) => o.tier === 'recommended')!;
    // Recommended has the "best fit" rationale.
    expect(rec.rationale).toBe('Best fit / preferred brand');
    // Its size (if known) should be at least as close to 55 as any other returned option's.
    if (rec.sizeIn != null) {
      const sized = resp.options.filter((o) => o.sizeIn != null);
      const recDelta = Math.abs(rec.sizeIn - 55);
      for (const o of sized) {
        expect(recDelta).toBeLessThanOrEqual(Math.abs((o.sizeIn as number) - 55) + 1e-9);
      }
    }
  });

  it('is deterministic across repeated calls', async () => {
    const a = await lcdOptions(quoteId, adminToken, { targetSizeIn: 55 });
    const b = await lcdOptions(quoteId, adminToken, { targetSizeIn: 55 });
    expect(a.options.map((o) => o.displayId)).toEqual(b.options.map((o) => o.displayId));
  });
});
