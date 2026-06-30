import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/** Exercises the wizard backend: add a priced LED screen + a licence, then recompute the quote. */
const JOB_PREFIX = `TESTSCR-${process.pid}-`;
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

describe('itemised price + cost masking (P1-16.8 / BR-081)', () => {
  it('admin sees itemised cost + sell; sales sees sell only on their own quote', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    // sales logs in and builds their own quote (scoping lets them price it)
    const salesLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'sales@quotezen.local', password: 'demo' },
    });
    const salesAuth = { authorization: `Bearer ${salesLogin.json().token as string}` };

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: salesAuth,
      payload: { jobReference: `${JOB_PREFIX}price-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/quotes/${id}/led-screens`,
      headers: salesAuth,
      payload: { ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });

    // sales price → cost masked
    const salesPrice = await app.inject({ method: 'POST', url: `/quotes/${id}/price`, headers: salesAuth });
    expect(salesPrice.statusCode).toBe(200);
    const sBody = salesPrice.json() as { costVisible: boolean; sections: Array<{ lines: Array<{ cost: string | null; sell: string | null }> }> };
    expect(sBody.costVisible).toBe(false);
    expect(sBody.sections[0]!.lines.every((l) => l.cost === null)).toBe(true);
    expect(sBody.sections[0]!.lines.some((l) => l.sell !== null)).toBe(true);

    // admin price (admin sees all) → cost visible
    const adminPrice = await app.inject({ method: 'POST', url: `/quotes/${id}/price`, headers: auth() });
    const aBody = adminPrice.json() as { costVisible: boolean; sections: Array<{ lines: Array<{ cost: string | null }> }> };
    expect(aBody.costVisible).toBe(true);
    expect(aBody.sections[0]!.lines.some((l) => l.cost !== null)).toBe(true);
  });
});

describe('quote outputs (P1-18)', () => {
  it('produces descriptions, BOM and solution summary from a configured screen', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}out-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/quotes/${id}/led-screens`,
      headers: auth(),
      payload: { screenName: 'Window', ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });

    const desc = await app.inject({ method: 'GET', url: `/quotes/${id}/descriptions`, headers: auth() });
    expect(desc.statusCode).toBe(200);
    expect((desc.json() as Array<{ description: string }>)[0]!.description).toMatch(/LED Screen/);

    const bom = await app.inject({ method: 'GET', url: `/quotes/${id}/bom`, headers: auth() });
    expect(bom.statusCode).toBe(200);
    const bomBody = bom.json() as Array<{ components: unknown[]; costLines: unknown[] }>;
    expect(bomBody[0]!.components.length).toBeGreaterThan(0);
    expect(bomBody[0]!.costLines.length).toBeGreaterThan(0);

    const summary = await app.inject({ method: 'GET', url: `/quotes/${id}/solution-summary`, headers: auth() });
    expect(summary.statusCode).toBe(200);
    const sBody = summary.json() as { assumptions: string[]; screens: unknown[] };
    expect(sBody.assumptions.length).toBeGreaterThan(0);
    expect(sBody.screens.length).toBe(1);

    const pm = await app.inject({ method: 'GET', url: `/quotes/${id}/pm-handoff`, headers: auth() });
    expect(pm.statusCode).toBe(200);
  });
});

describe('configuration engine', () => {
  it('returns ranked valid configs for an opening from the live catalogue', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}cfg-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/screens/configure`,
      headers: auth(),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { options: Array<{ model: string; fillPercent: string; resolutionWpx: number }>; reasons: string[] };
    expect(body.options.length).toBeGreaterThan(0);
    expect(body.options[0]).toHaveProperty('fillPercent');
    expect(body.options[0]).toHaveProperty('resolutionWpx');
  });
});

describe('per-screen qty rollup + management (P1-14)', () => {
  it('a screen with qty 2 contributes 2× its per-unit priceTotal to the equipment rollup', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}qty-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;

    const led = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/led-screens`,
      headers: auth(),
      payload: { screenName: 'Qty screen', ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });
    const screen = led.json();
    const unit = Number(screen.priceTotal);
    expect(unit).toBeGreaterThan(0);

    // qty 1 → equipment == 1× unit
    const r1 = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/recompute`, headers: auth() });
    expect(Number(r1.json().totalEquipment)).toBeCloseTo(unit, 2);

    // bump qty to 2 → equipment == 2× unit
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}/led-screens/${screen.id}/qty`,
      headers: auth(),
      payload: { qty: 2 },
    });
    expect(patched.statusCode).toBe(200);
    expect(Number(patched.json().totalEquipment)).toBeCloseTo(unit * 2, 2);

    // qty 0 is rejected (positive int only) — Zod validation failure → 422
    const bad = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}/led-screens/${screen.id}/qty`,
      headers: auth(),
      payload: { qty: 0 },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('duplicates a screen and reorders the set', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    const created = await app.inject({
      method: 'POST', url: '/quotes', headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}dup-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;
    const led = await app.inject({
      method: 'POST', url: `/quotes/${quoteId}/led-screens`, headers: auth(),
      payload: { screenName: 'Original', ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });
    const origId = led.json().id as string;

    const dup = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/led-screens/${origId}/duplicate`, headers: auth() });
    expect(dup.statusCode).toBe(201);

    const quote = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() });
    const screens = (quote.json() as { ledScreens: Array<{ id: string; screenName: string }> }).ledScreens;
    expect(screens.length).toBe(2);
    expect(screens.some((s) => s.screenName === 'Original (copy)')).toBe(true);

    // reorder: reverse the current order
    const reversed = screens.map((s) => Number(s.id)).reverse();
    const reord = await app.inject({
      method: 'POST', url: `/quotes/${quoteId}/led-screens/reorder`, headers: auth(),
      payload: { orderedIds: reversed },
    });
    expect(reord.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() });
    const afterIds = (after.json() as { ledScreens: Array<{ id: string }> }).ledScreens.map((s) => Number(s.id));
    expect(afterIds).toEqual(reversed);
  });
});

describe('quote wizard backend', () => {
  it('prices an LED screen from a real product and rolls it into the quote total', async () => {
    // a product with the specs needed to price (cabinet dims, pitch, cost/sqm)
    const product = await prisma.ledProduct.findFirst({
      where: {
        minCabinetWMm: { not: null },
        minCabinetHMm: { not: null },
        pixelPitchH: { not: null },
        costPerSqmUsd: { not: null },
      },
    });
    expect(product).toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;

    // add an LED screen
    const led = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/led-screens`,
      headers: auth(),
      payload: {
        screenName: 'Window screen',
        ledProductId: Number(product!.id),
        qty: 1,
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        rotateCabinets: true,
      },
    });
    expect(led.statusCode).toBe(201);
    const screen = led.json();
    expect(Number(screen.priceTotal)).toBeGreaterThan(0);
    expect(screen.resolutionWpx).toBeGreaterThan(0);

    // add a licence line
    const lic = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/licences`,
      headers: auth(),
      payload: { screenType: 'LED', tier: 'low', qty: 1, isInteractive: false },
    });
    expect(lic.statusCode).toBe(201);

    // recompute → equipment total should equal the LED screen price
    const recomputed = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/recompute`,
      headers: auth(),
    });
    expect(recomputed.statusCode).toBe(200);
    const body = recomputed.json();
    expect(Number(body.totalEquipment)).toBeCloseTo(Number(screen.priceTotal), 2);
    expect(Number(body.grandTotal)).toBeGreaterThan(0);

    // delete the screen → recompute drops to zero equipment
    const del = await app.inject({
      method: 'DELETE',
      url: `/quotes/${quoteId}/led-screens/${screen.id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/recompute`, headers: auth() });
    expect(Number(after.json().totalEquipment)).toBe(0);
  });
});
