import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Review page (POST /quotes/:id/price):
 *   • `breakdown` — by type, per screen + whole job; each screen's groups add up to its price;
 *   • `totals.marginBasis` — admin-only cost + pre-discount sell, from which a TARGET margin converts to
 *     the discount that delivers it: d = 1 − cost / (sell × (1 − margin)).
 * Live-DB integration; quotes use the job-ref prefix and are deleted afterwards.
 */
const JOB_PREFIX = `TESTREVIEW-${process.pid}-`;
const SLOW = { timeout: 600_000 };
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

type Price = {
  sections: Array<{ type: string; screenId?: string; total: string }>;
  breakdown: {
    screens: Array<{ screenId: string; total: number; groups: Record<string, { sell: number; cost: number | null }> }>;
    job: { total: number; groups: Record<string, { sell: number; cost: number | null }> };
  };
  totals: { margin: string | null; marginBasis: { cost: string; sellBeforeDiscount: string } | null };
};

let quoteId: string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  token = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@quotezen.local', password: 'demo' } })
  ).json().token as string;

  // One LCD screen with a display (screen), a media player and an install line (labour).
  const display = await prisma.displayCatalog.findFirstOrThrow({ where: { totalCost: { gt: 0 }, deprecated: false, category: { contains: 'indoor', mode: 'insensitive' } } });
  const player = await prisma.displayCatalog.findFirst({ where: { totalCost: { gt: 0 }, deprecated: false, category: { contains: 'mediaplayer', mode: 'insensitive' } } });
  quoteId = (
    await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    })
  ).json().id as string;
  const add = await app.inject({
    method: 'POST',
    url: `/quotes/${quoteId}/lcd-screens`,
    headers: auth(),
    payload: {
      screenName: 'Review LCD',
      items: [
        { itemType: 'display', displayId: Number(display.id), qty: 1 },
        ...(player ? [{ itemType: 'mediaplayer', displayId: Number(player.id), qty: 1 }] : []),
        { itemType: 'install', description: 'Installation, Per hour', qty: 3, unitCost: 95 },
      ],
    },
  });
  expect(add.statusCode).toBe(201);
}, 600_000);

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const price = async (): Promise<Price> =>
  (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() })).json() as Price;

describe('breakdown by type', () => {
  it('per-screen groups add up to the screen price; the job column to all screens', SLOW, async () => {
    const p = await price();
    const section = p.sections.find((s) => s.type === 'lcd')!;
    const screen = p.breakdown.screens.find((s) => s.screenId === section.screenId)!;
    expect(screen.total).toBeCloseTo(Number(section.total), 2);
    const parts = Object.values(screen.groups).reduce((a, g) => a + g.sell, 0);
    expect(parts).toBeCloseTo(screen.total, 2);
    expect(screen.groups.screen!.sell).toBeGreaterThan(0);
    expect(screen.groups.labour!.sell).toBeGreaterThan(0);
    expect(p.breakdown.job.total).toBeCloseTo(screen.total, 2);
    expect(screen.groups.screen!.cost).not.toBeNull(); // admin sees cost
  });
});

describe('target margin → discount', () => {
  it('the discount worked out from a target margin delivers that margin', SLOW, async () => {
    const p = await price();
    expect(p.totals.marginBasis).not.toBeNull();
    const cost = Number(p.totals.marginBasis!.cost);
    const sell = Number(p.totals.marginBasis!.sellBeforeDiscount);
    const noDiscountMargin = (sell - cost) / sell;
    const target = Math.max(0.05, noDiscountMargin - 0.03); // a few points below → a small discount
    const discount = 1 - cost / (sell * (1 - target));
    expect(discount).toBeGreaterThan(0);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}`,
      headers: auth(),
      payload: { discountPct: Math.round(discount * 10000) / 10000, discountScope: 'one_off', discountNote: 'target margin test' },
    });
    expect(patch.statusCode).toBe(200);
    const after = await price();
    expect(Number(after.totals.margin)).toBeCloseTo(target, 3);
    // The basis is the PRE-discount sell — unchanged by the discount just applied.
    expect(Number(after.totals.marginBasis!.sellBeforeDiscount)).toBeCloseTo(sell, 2);
  });
});
