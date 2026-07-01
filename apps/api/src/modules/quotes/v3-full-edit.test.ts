import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * V3 — full re-edit endpoints for existing screens:
 *  • PUT /quotes/:id/led-screens/:screenId re-edits the whole LED add form (product/geometry/option),
 *    re-prices via the same path as add, rolls into the quote total, preserves id/sortOrder/qty.
 *  • PUT /quotes/:id/lcd-screens/:screenId replaces the LCD line items + re-prices.
 */
const JOB_PREFIX = `TESTV3-${process.pid}-`;
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
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const newQuote = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return res.json().id as string;
};

describe('V3 — PUT LED screen (full re-edit)', () => {
  it('changes product/geometry/option, re-prices, rolls into the quote total, preserves sortOrder/qty', async () => {
    const products = await prisma.ledProduct.findMany({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, pixelPitchV: { not: null }, costPerSqmUsd: { not: null }, deprecated: false },
      take: 2,
    });
    expect(products.length).toBe(2);
    const [p1, p2] = products;
    const engineering = await prisma.engineeringOption.findFirst({ where: { deprecated: false, price: { gt: 0 } } });
    expect(engineering).toBeTruthy();

    const quoteId = await newQuote();

    // Add TWO screens so we can prove sortOrder is preserved on the first one.
    const add = async (productId: bigint, name: string, qty: number) =>
      app.inject({
        method: 'POST',
        url: `/quotes/${quoteId}/led-screens`,
        headers: auth(),
        payload: { screenName: name, ledProductId: Number(productId), qty, desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
      });
    const first = (await add(p1!.id, 'Screen A', 3)).json();
    const second = (await add(p2!.id, 'Screen B', 1)).json();
    expect(Number(first.sortOrder)).toBe(0);
    expect(Number(second.sortOrder)).toBe(1);
    const priceBefore = Number(first.priceTotal);
    expect(priceBefore).toBeGreaterThan(0);

    // Full re-edit the FIRST screen: switch product + change geometry + attach engineering.
    // Note: NO qty in the body → qty must be preserved (3).
    const put = await app.inject({
      method: 'PUT',
      url: `/quotes/${quoteId}/led-screens/${first.id}`,
      headers: auth(),
      payload: {
        screenName: 'Screen A (edited)',
        ledProductId: Number(p2!.id),
        desiredWidthMm: 2240,
        desiredHeightMm: 1920,
        rotateCabinets: true,
        engineeringId: Number(engineering!.id),
      },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json();

    // Same row (id preserved), sortOrder preserved, qty preserved (not sent).
    expect(String(updated.id)).toBe(String(first.id));
    expect(Number(updated.sortOrder)).toBe(0);
    expect(Number(updated.qty)).toBe(3);
    // Product + geometry actually changed.
    expect(String(updated.ledProductId)).toBe(String(p2!.id));
    expect(Number(updated.desiredWidthMm)).toBe(2240);
    expect(updated.screenName).toBe('Screen A (edited)');
    // Re-priced (larger area + engineering) → price changed.
    expect(Number(updated.priceTotal)).not.toBe(priceBefore);
    expect(Number(updated.priceTotal)).toBeGreaterThan(0);
    expect(String(updated.engineeringId)).toBe(String(engineering!.id));
    // Fresh children returned.
    expect(Array.isArray(updated.costBreakdown)).toBe(true);
    expect(updated.costBreakdown.length).toBeGreaterThan(0);

    // Quote rollup reflects both re-priced screens (qty multiplied).
    const quote = (await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() })).json();
    const a = quote.ledScreens.find((s: { id: string }) => String(s.id) === String(first.id));
    const b = quote.ledScreens.find((s: { id: string }) => String(s.id) === String(second.id));
    const expectedEquip = Number(a.priceTotal) * Number(a.qty) + Number(b.priceTotal) * Number(b.qty);
    expect(Number(quote.totalEquipment)).toBeCloseTo(expectedEquip, 1);
  });

  it('replaces the component list on a full re-edit', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, pixelPitchV: { not: null }, costPerSqmUsd: { not: null }, deprecated: false },
    });
    const controller = await prisma.controller.findFirst({ where: { deprecated: false } });
    expect(controller).toBeTruthy();
    const quoteId = await newQuote();

    const created = (await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/led-screens`,
      headers: auth(),
      payload: {
        ledProductId: Number(product!.id),
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        rotateCabinets: true,
        components: [{ componentType: 'controller', controllerId: Number(controller!.id), qty: 2 }],
      },
    })).json();
    expect(created.components.length).toBe(1);

    // Re-edit with NO components → the component list is replaced (emptied).
    const put = await app.inject({
      method: 'PUT',
      url: `/quotes/${quoteId}/led-screens/${created.id}`,
      headers: auth(),
      payload: { ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true, components: [] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().components.length).toBe(0);
  });
});

describe('V3 — PUT LCD screen (full re-edit)', () => {
  it('replaces items + re-prices, preserves id/sortOrder', async () => {
    const display = await prisma.displayCatalog.findFirst({ where: { deprecated: false, totalCost: { not: null } } });
    expect(display).toBeTruthy();
    const quoteId = await newQuote();

    const created = (await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD A',
        items: [
          { itemType: 'display', displayId: Number(display!.id), qty: 1 },
          { itemType: 'install', description: 'Installation, Per hour', qty: 1, unitCost: 95 },
        ],
      },
    })).json();
    const priceBefore = Number(created.priceTotal);
    expect(priceBefore).toBeGreaterThan(0);
    expect(created.items.length).toBe(2);

    // Full re-edit: fewer + different items → re-prices, replaces items.
    const put = await app.inject({
      method: 'PUT',
      url: `/quotes/${quoteId}/lcd-screens/${created.id}`,
      headers: auth(),
      payload: {
        screenName: 'LCD A (edited)',
        items: [
          { itemType: 'display', displayId: Number(display!.id), qty: 3 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json();
    expect(String(updated.id)).toBe(String(created.id));
    expect(Number(updated.sortOrder)).toBe(Number(created.sortOrder));
    expect(updated.screenName).toBe('LCD A (edited)');
    // Items fully replaced (only the display row now; qty 3).
    expect(updated.items.length).toBe(1);
    expect(Number(updated.items[0].qty)).toBe(3);
    // Re-priced (qty 3 display, install line gone) → total changed.
    expect(Number(updated.priceTotal)).not.toBe(priceBefore);
    expect(Number(updated.priceTotal)).toBeGreaterThan(0);

    // Rolls into the quote equipment total. Note: the LCD rollup sums the raw extended line sells
    // (Σ unitSell × qty), while the stored priceTotal is the G54 $10-rounded figure — so compare the
    // total against the summed line sells (the same basis recompute uses), not the rounded priceTotal.
    const quote = (await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() })).json();
    const lineSells = (updated.items as Array<{ unitSell: string; qty: number }>).reduce(
      (a, i) => a + Number(i.unitSell) * Number(i.qty),
      0,
    );
    expect(Number(quote.totalEquipment)).toBeCloseTo(lineSells, 1);
  });
});
