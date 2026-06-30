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

describe('missing-rate hard stops (P1-16.9 / P1-07.5) + rule-set snapshot (P1-04.1)', () => {
  it('hard-stops when a SELECTED freight option has no rate (never silently $0 freight)', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    // a freight option with NO rate configured (misconfiguration)
    const badFreight = await prisma.freightOption.create({
      data: { name: `TEST no-rate freight ${process.pid}-${Math.floor(Math.random() * 1e9)}`, rate: null },
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/quotes',
        headers: auth(),
        payload: { jobReference: `${JOB_PREFIX}freight-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
      });
      const id = created.json().id as string;
      const res = await app.inject({
        method: 'POST',
        url: `/quotes/${id}/led-screens`,
        headers: auth(),
        payload: {
          ledProductId: Number(product!.id),
          desiredWidthMm: 1120,
          desiredHeightMm: 1920,
          rotateCabinets: true,
          freightOptionId: Number(badFreight.id),
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
      expect(res.json().error.message).toMatch(/has no rate configured/);
    } finally {
      await prisma.freightOption.delete({ where: { id: badFreight.id } });
    }
  });

  it('records the rule-set in force (markups/freight/addOns/rates/marginFloor) into a version snapshot', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}ruleset-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/quotes/${id}/led-screens`,
      headers: auth(),
      payload: { ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });
    const v1 = await app.inject({ method: 'POST', url: `/quotes/${id}/versions`, headers: auth(), payload: { label: 'rules' } });
    expect(v1.statusCode).toBe(201);

    const snap = await app.inject({ method: 'GET', url: `/quotes/${id}/versions/1`, headers: auth() });
    expect(snap.statusCode).toBe(200);
    const ruleSet = (snap.json() as { snapshot: { ruleSet?: Record<string, unknown> } }).snapshot.ruleSet;
    expect(ruleSet).toBeTruthy();
    expect((ruleSet!.markups as { ledMargin: number }).ledMargin).toBeGreaterThan(0);
    expect((ruleSet!.rates as { AUD: number }).AUD).toBe(1);
    expect(ruleSet!.freight).toBeTruthy();
    expect(ruleSet!.addOns).toBeTruthy();
    expect(typeof ruleSet!.marginFloor).toBe('number');
    expect(typeof ruleSet!.capturedAt).toBe('string');
  });
});

describe('per-screen input fields round-trip (S0)', () => {
  it('persists orientation + aspectRatioId + backCover on an LED screen and returns the ratio label', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    const ratio = await prisma.screenRatio.findFirst({ where: { deprecated: false } });
    expect(ratio).toBeTruthy();

    const created = await app.inject({
      method: 'POST', url: '/quotes', headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}inputs-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;

    const led = await app.inject({
      method: 'POST', url: `/quotes/${quoteId}/led-screens`, headers: auth(),
      payload: {
        screenName: 'Inputs screen',
        ledProductId: Number(product!.id),
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        rotateCabinets: true,
        orientation: 'Portrait',
        aspectRatioId: Number(ratio!.id),
        backCover: true,
        frameNote: 'Custom housing',
        serviceDescriptionSuffix: 'after hours',
      },
    });
    expect(led.statusCode).toBe(201);
    const screen = led.json();
    expect(screen.orientation).toBe('Portrait');
    expect(screen.backCover).toBe(true);
    expect(String(screen.aspectRatioId)).toBe(String(ratio!.id));
    expect(screen.frameNote).toBe('Custom housing');
    expect(screen.serviceDescriptionSuffix).toBe('after hours');

    // GET the quote → the include should resolve the aspectRatio label
    const quote = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() });
    const got = (quote.json() as { ledScreens: Array<{ orientation: string; backCover: boolean; aspectRatio: { ratioLabel: string } | null }> }).ledScreens[0]!;
    expect(got.orientation).toBe('Portrait');
    expect(got.backCover).toBe(true);
    expect(got.aspectRatio?.ratioLabel).toBe(ratio!.ratioLabel);
  });

  it('persists orientation on an LCD screen', async () => {
    const created = await app.inject({
      method: 'POST', url: '/quotes', headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}lcd-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;
    const lcd = await app.inject({
      method: 'POST', url: `/quotes/${quoteId}/lcd-screens`, headers: auth(),
      payload: { screenName: 'LCD', orientation: 'P', items: [] },
    });
    expect(lcd.statusCode).toBe(201);
    expect(lcd.json().orientation).toBe('P');
  });
});

describe('LCD-1 faithful pricing (S2)', () => {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const sellAtMargin = (cost: number) => round2(cost / (1 - 0.3)); // lcd_margin = 0.3 (F12)

  it('prices catalog + manual items at fixed margin, applies out-of-hours uplift, persists subtotals', async () => {
    // A catalog display with a known total_cost so we can assert the server-resolved (authoritative) price.
    const display = await prisma.displayCatalog.findFirst({ where: { deprecated: false, totalCost: { not: null } } });
    expect(display).toBeTruthy();
    const displayCost = Number(display!.totalCost);

    const outOfHours = await prisma.serviceHoursOption.findFirst({ where: { name: { not: 'Business Hours' } } });
    expect(outOfHours).toBeTruthy();
    // Out-of-hours uplift is hours-based: install hours = install cost / install_hourly_cost ($95),
    // charged at the uplift rate ($50 cost / $80 sell per hour). Defaults if settings absent.
    const num = async (k: string, d: number) =>
      Number((await prisma.setting.findUnique({ where: { key: k } }))?.value ?? d);
    const installHourly = await num('install_hourly_cost', 95);
    const oohCost = await num('out_of_hours_rate_cost', 50);
    const oohSell = await num('out_of_hours_rate_sell', 80);

    const created = await app.inject({
      method: 'POST', url: '/quotes', headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}lcdprice-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;

    // display (catalog) + a manual install row ($95 cost) + a manual labour row ($30) → out-of-hours uplift.
    const lcd = await app.inject({
      method: 'POST', url: `/quotes/${quoteId}/lcd-screens`, headers: auth(),
      payload: {
        screenName: 'LCD priced', orientation: 'L',
        serviceHoursId: Number(outOfHours!.id),
        items: [
          { itemType: 'display', displayId: Number(display!.id), qty: 2 },
          { itemType: 'install', description: 'Installation, Per hour', qty: 1, unitCost: 95 },
          { itemType: 'labour', description: 'Consumables', qty: 1, unitCost: 30 },
        ],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as {
      items: Array<{ itemType: string; displayId: string | null; unitCost: string; unitSell: string; description: string | null }>;
      priceScreenMediaplayer: string; priceBracketShroud: string; priceServices: string; priceTotal: string;
    };

    // Catalog price is resolved server-side (ignores client-sent prices) at the fixed margin.
    const displayItem = screen.items.find((i) => i.itemType === 'display')!;
    expect(Number(displayItem.unitCost)).toBe(round2(displayCost));
    expect(Number(displayItem.unitSell)).toBe(sellAtMargin(displayCost));

    // Manual rows keep their cost; sell = cost grossed up by the margin.
    const installItem = screen.items.find((i) => i.itemType === 'install' && i.description === 'Installation, Per hour')!;
    expect(Number(installItem.unitCost)).toBe(95);
    expect(Number(installItem.unitSell)).toBe(sellAtMargin(95));

    // Out-of-hours uplift is a labour-cost calc: only the 'install' row (per-hour, $95) counts as hours
    // (labour 'Consumables' is excluded — workbook K28:K29 are install rows). hours = 95/95 = 1 →
    // cost = 1×$50, sell = 1×$80 (the uplift rate, NOT a margin gross-up).
    const upliftHours = 95 / installHourly; // = 1
    const upliftCost = round2(upliftHours * oohCost); // 50
    const upliftSell = round2(upliftHours * oohSell); // 80
    const upliftItem = screen.items.find((i) => i.description?.startsWith('Out of Hours uplift'));
    expect(upliftItem).toBeTruthy();
    expect(Number(upliftItem!.unitCost)).toBe(upliftCost);
    expect(Number(upliftItem!.unitSell)).toBe(upliftSell);

    // Section subtotals + grand total (G54: rounded to nearest 10).
    const expectScreenMp = sellAtMargin(displayCost) * 2;
    expect(Number(screen.priceScreenMediaplayer)).toBeCloseTo(expectScreenMp, 2);
    expect(Number(screen.priceBracketShroud)).toBe(0);
    const expectServices = sellAtMargin(95) + sellAtMargin(30) + upliftSell;
    expect(Number(screen.priceServices)).toBeCloseTo(expectServices, 2);
    const expectTotal = Math.round((expectScreenMp + expectServices) / 10) * 10;
    expect(Number(screen.priceTotal)).toBe(expectTotal);
  });

  it('does NOT add an out-of-hours uplift for Business Hours', async () => {
    const businessHours = await prisma.serviceHoursOption.findFirst({ where: { name: 'Business Hours' } });
    const created = await app.inject({
      method: 'POST', url: '/quotes', headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}lcdbh-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;
    const lcd = await app.inject({
      method: 'POST', url: `/quotes/${quoteId}/lcd-screens`, headers: auth(),
      payload: {
        screenName: 'LCD BH', serviceHoursId: businessHours ? Number(businessHours.id) : undefined,
        items: [{ itemType: 'install', description: 'Installation, Per hour', qty: 1, unitCost: 95 }],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const items = (lcd.json() as { items: Array<{ description: string | null }> }).items;
    expect(items.some((i) => i.description?.startsWith('Out of Hours uplift'))).toBe(false);
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
