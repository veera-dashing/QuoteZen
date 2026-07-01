import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * V2 — per-line discounts + discount mode.
 *  - A per-line % reduces that line's sell → lower screen total, grand total, and margin.
 *  - discountMode 'stack' (default): per-line AND quote/client discount both apply.
 *  - discountMode 'item_only': the quote/client discount is suppressed when any per-line discount exists.
 *  - A large per-line discount trips the non-admin margin-floor block; admin can override (audited).
 */
const JOB_PREFIX = `V2LD-${process.pid}-`;
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

/** Create a quote with one LED screen; optionally set a quote-level discount, client, or discountMode. */
const newQuoteWithScreen = async (
  headers: Record<string, string>,
  opts: { discountPct?: number; clientId?: number; discountMode?: 'stack' | 'item_only' } = {},
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
      ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
    },
  });
  const id = created.json().id as string;
  if (opts.discountMode !== undefined) {
    // discountMode is a per-quote setting applied via PATCH /quotes/:id (V2).
    await app.inject({ method: 'PATCH', url: `/quotes/${id}`, headers, payload: { discountMode: opts.discountMode } });
  }
  await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers,
    payload: { ledProductId: Number(product.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  return id;
};

interface Price {
  discountMode: string;
  hasLineDiscounts: boolean;
  discount: { pct: number; source: string; amount: string };
  sections: Array<{
    type: string;
    total: string;
    computedTotal?: string;
    lines: Array<{ id: string; sell: string | null; discountPct: number | null; effectiveSell: string }>;
  }>;
  totals: { equipment: string; services: string; grandTotal: string; margin: string | null };
}

const priceOf = async (id: string, headers: Record<string, string>) =>
  (await app.inject({ method: 'POST', url: `/quotes/${id}/price`, headers })).json() as Price;

/** The first LED cost-breakdown line id with a non-zero sell (a good candidate to discount). */
const firstSellableLedLine = (price: Price) => {
  const led = price.sections.find((s) => s.type === 'led')!;
  return led.lines.find((l) => l.sell != null && Number(l.sell) > 0)!;
};

const setLedLineDiscount = (id: string, lineId: string, discountPct: number | null, headers: Record<string, string>) =>
  app.inject({
    method: 'PATCH',
    url: `/quotes/${id}/led-lines/${lineId}/discount`,
    headers,
    payload: { discountPct },
  });

describe('V2 — a per-line discount reduces screen total, grand total, and margin', () => {
  it('discounting one LED cost line lowers that line, the screen total, grandTotal and margin', async () => {
    const id = await newQuoteWithScreen(admin());
    const before = await priceOf(id, admin());
    const line = firstSellableLedLine(before);
    const ledSectionBefore = before.sections.find((s) => s.type === 'led')!;
    const marginBefore = Number(before.totals.margin);
    const grandBefore = Number(before.totals.grandTotal);
    expect(grandBefore).toBeGreaterThan(0);
    expect(line.discountPct).toBeNull();

    // 50% off this one line
    const patched = await setLedLineDiscount(id, line.id, 0.5, admin());
    expect(patched.statusCode).toBe(200);

    const after = await priceOf(id, admin());
    expect(after.hasLineDiscounts).toBe(true);
    const patchedLine = after.sections
      .find((s) => s.type === 'led')!
      .lines.find((l) => l.id === line.id)!;
    expect(patchedLine.discountPct).toBe(0.5);
    // effective sell = sell × 0.5
    expect(Number(patchedLine.effectiveSell)).toBeCloseTo(Number(line.sell) * 0.5, 1);

    // The screen section total drops by half the discounted line's sell.
    const ledSectionAfter = after.sections.find((s) => s.type === 'led')!;
    const drop = Number(line.sell) * 0.5;
    expect(Number(ledSectionAfter.total)).toBeCloseTo(Number(ledSectionBefore.total) - drop, 0);
    expect(Number(after.totals.grandTotal)).toBeLessThan(grandBefore);
    // Cost is unchanged so margin must fall.
    expect(Number(after.totals.margin)).toBeLessThan(marginBefore);
  });

  it('clearing the per-line discount restores totals to the baseline', async () => {
    const id = await newQuoteWithScreen(admin());
    const base = await priceOf(id, admin());
    const line = firstSellableLedLine(base);
    const grandBase = Number(base.totals.grandTotal);

    await setLedLineDiscount(id, line.id, 0.3, admin());
    const discounted = await priceOf(id, admin());
    expect(Number(discounted.totals.grandTotal)).toBeLessThan(grandBase);

    const cleared = await setLedLineDiscount(id, line.id, null, admin());
    expect(cleared.statusCode).toBe(200);
    const after = await priceOf(id, admin());
    expect(after.hasLineDiscounts).toBe(false);
    expect(Number(after.totals.grandTotal)).toBeCloseTo(grandBase, 1);
  });
});

describe('V2 — discountMode: stack vs item_only', () => {
  it("'stack' (default): the quote discount applies ON TOP of the per-line discount", async () => {
    const id = await newQuoteWithScreen(admin(), { discountPct: 0.1 }); // default mode = stack
    const before = await priceOf(id, admin());
    const line = firstSellableLedLine(before);

    await setLedLineDiscount(id, line.id, 0.2, admin());
    const after = await priceOf(id, admin());
    // The 10% quote discount still applies (both layers).
    expect(after.discountMode).toBe('stack');
    expect(after.hasLineDiscounts).toBe(true);
    expect(after.discount.pct).toBe(0.1);
    expect(Number(after.discount.amount)).toBeGreaterThan(0);
    // Grand total = (per-line-discounted equipment+services) × (1 − 0.1).
    const upfront = Number(after.totals.equipment) + Number(after.totals.services);
    expect(Number(after.totals.grandTotal)).toBeCloseTo(upfront * 0.9, 0);
  });

  it("'item_only': the quote discount is suppressed once a per-line discount exists", async () => {
    const id = await newQuoteWithScreen(admin(), { discountPct: 0.1, discountMode: 'item_only' });
    const beforeLine = await priceOf(id, admin());
    // No per-line discount yet → the quote discount DOES apply.
    expect(beforeLine.discountMode).toBe('item_only');
    expect(beforeLine.hasLineDiscounts).toBe(false);
    expect(beforeLine.discount.pct).toBe(0.1);

    const line = firstSellableLedLine(beforeLine);
    await setLedLineDiscount(id, line.id, 0.2, admin());
    const after = await priceOf(id, admin());
    // Now a per-line discount exists → the quote/client discount is suppressed.
    expect(after.hasLineDiscounts).toBe(true);
    expect(after.discount.pct).toBe(0);
    expect(Number(after.discount.amount)).toBe(0);
    // Grand total = the per-line-discounted upfront, with NO extra quote discount.
    const upfront = Number(after.totals.equipment) + Number(after.totals.services);
    expect(Number(after.totals.grandTotal)).toBeCloseTo(upfront, 0);
  });
});

describe('V2 — a deep per-line discount trips the non-admin margin floor', () => {
  it('blocks non-admin finalisation (403); admin can override (audited)', async () => {
    await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } });

    // sales quote; discount every LED cost line 95% → margin tanks below the floor.
    const blockedId = await newQuoteWithScreen(sales());
    const blockedPrice = await priceOf(blockedId, sales());
    const ledLines = blockedPrice.sections.find((s) => s.type === 'led')!.lines.filter((l) => l.sell != null);
    for (const l of ledLines) await setLedLineDiscount(blockedId, l.id, 0.95, sales());

    const blocked = await app.inject({
      method: 'POST',
      url: `/quotes/${blockedId}/status`,
      headers: sales(),
      payload: { status: 'approved' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/below the floor/);

    // admin can push the same deep-discounted quote through (audited).
    const adminId = await newQuoteWithScreen(admin());
    const adminPrice = await priceOf(adminId, admin());
    const adminLines = adminPrice.sections.find((s) => s.type === 'led')!.lines.filter((l) => l.sell != null);
    for (const l of adminLines) await setLedLineDiscount(adminId, l.id, 0.95, admin());

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
  });
});

describe('V2 — LCD per-line discount', () => {
  it('discounting an LCD item lowers the screen total + grand total', async () => {
    const display = await prisma.displayCatalog.findFirst({ where: { deprecated: false, totalCost: { not: null } } });
    expect(display).toBeTruthy();
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: admin(),
      payload: { jobReference: `${JOB_PREFIX}lcd-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/quotes/${id}/lcd-screens`,
      headers: admin(),
      payload: { screenName: 'LCD', orientation: 'L', items: [{ itemType: 'display', displayId: Number(display!.id), qty: 2 }] },
    });

    const before = await priceOf(id, admin());
    const lcd = before.sections.find((s) => s.type === 'lcd')!;
    const item = lcd.lines.find((l) => l.sell != null && Number(l.sell) > 0)!;
    const grandBefore = Number(before.totals.grandTotal);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}/lcd-items/${item.id}/discount`,
      headers: admin(),
      payload: { discountPct: 0.5 },
    });
    expect(patched.statusCode).toBe(200);

    const after = await priceOf(id, admin());
    const lcdAfter = after.sections.find((s) => s.type === 'lcd')!;
    const itemAfter = lcdAfter.lines.find((l) => l.id === item.id)!;
    expect(itemAfter.discountPct).toBe(0.5);
    // qty=2 → effective sell = unitSell × 2 × 0.5.
    expect(Number(itemAfter.effectiveSell)).toBeCloseTo(Number(item.sell) * 2 * 0.5, 0);
    expect(Number(after.totals.grandTotal)).toBeLessThan(grandBefore);
  });
});
