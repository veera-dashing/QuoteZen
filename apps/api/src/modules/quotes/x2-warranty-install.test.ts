import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * X2 — LCD extended-warranty ($/extra-year) + install-method labour pricing.
 *
 * Live-RDS integration (like the other LCD tests). We mutate the shared reference rows we need
 * (the Extended warranty option's per_year_cost, one install method's default_hours) and RESTORE
 * them in afterAll so we don't pollute the shared DB for other suites.
 */
const JOB_PREFIX = `TESTX2-${process.pid}-`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const sellAtMargin = (cost: number) => round2(cost / (1 - 0.3)); // lcd_margin = 0.3 (F12)

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

// Rows we mutate + their original values (restored in afterAll).
let extendedWarrantyId: bigint;
let extendedWarrantyOrigPerYear: string; // Decimal serialised
let extendedWarrantyYears: number;
let standardWarrantyId: bigint | null = null;
// The live RDS has no install_methods rows (they were never seeded there), so this test CREATES a
// dedicated method (default_hours 4, hourly_rate_cost null ⇒ falls back to install_hourly_cost $95)
// and deletes it in afterAll.
let installMethodId: bigint;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;

  // Extended warranty (5 years) → set a known per-year cost so extraYears = 5 - 3 = 2.
  const extended = await prisma.warrantyOption.findFirst({ where: { years: { gt: 3 } } });
  expect(extended).toBeTruthy();
  extendedWarrantyId = extended!.id;
  extendedWarrantyYears = extended!.years;
  extendedWarrantyOrigPerYear = extended!.perYearCost.toString();
  await prisma.warrantyOption.update({ where: { id: extendedWarrantyId }, data: { perYearCost: 150 } });

  // A standard warranty (≤ 3 years) → should never add a warranty line (extraYears 0).
  const standard = await prisma.warrantyOption.findFirst({ where: { years: { lte: 3 } } });
  standardWarrantyId = standard?.id ?? null;

  // Create a dedicated install method (default_hours 4, hourly_rate_cost null ⇒ $95 setting fallback).
  const method = await prisma.installMethod.create({
    data: { name: `X2 Test Method ${process.pid}`, defaultHours: 4, hourlyRateCost: null },
  });
  installMethodId = method.id;
});

afterAll(async () => {
  // Clean up test quotes.
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  // Restore / clean up the reference rows we touched so the shared RDS is left as we found it.
  if (extendedWarrantyId != null) {
    await prisma.warrantyOption.update({
      where: { id: extendedWarrantyId },
      data: { perYearCost: extendedWarrantyOrigPerYear },
    });
  }
  if (installMethodId != null) {
    await prisma.installMethod.delete({ where: { id: installMethodId } }).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

const newQuote = async (tag: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${tag}-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return created.json().id as string;
};

type LcdScreenJson = {
  id: string;
  sortOrder: number;
  items: Array<{ itemType: string; description: string | null; qty: number; unitCost: string; unitSell: string }>;
  priceServices: string;
  priceTotal: string;
};

describe('X2 — LCD extended warranty pricing', () => {
  it('adds a warranty line for extra years beyond the 3yr baseline, in priceTotal', async () => {
    const quoteId = await newQuote('warr');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD warranty',
        warrantyId: Number(extendedWarrantyId),
        items: [],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;

    const extraYears = extendedWarrantyYears - 3; // 2
    const expectCost = extraYears * 150; // 300
    const warrantyItem = screen.items.find((i) => i.itemType === 'warranty');
    expect(warrantyItem).toBeTruthy();
    expect(Number(warrantyItem!.unitCost)).toBe(expectCost);
    expect(Number(warrantyItem!.unitSell)).toBe(sellAtMargin(expectCost));

    // Warranty is grouped into services + folded into the grand total (rounded to $10).
    expect(Number(screen.priceServices)).toBeCloseTo(sellAtMargin(expectCost), 2);
    const expectTotal = Math.round(sellAtMargin(expectCost) / 10) * 10;
    expect(Number(screen.priceTotal)).toBe(expectTotal);
  });

  it('adds NO warranty line for a standard (3yr) warranty (extraYears 0)', async () => {
    if (!standardWarrantyId) return; // no ≤3yr option seeded
    const quoteId = await newQuote('std');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: { screenName: 'LCD std warranty', warrantyId: Number(standardWarrantyId), items: [] },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;
    expect(screen.items.find((i) => i.itemType === 'warranty')).toBeUndefined();
  });
});

describe('X2 — LCD install-method labour pricing', () => {
  it('adds an install-method labour line = defaultHours × $95 (rate fallback)', async () => {
    const quoteId = await newQuote('inst');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD install',
        installMethodId: Number(installMethodId),
        items: [],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;

    const installItem = screen.items.find(
      (i) => i.itemType === 'install' && (i.description ?? '').startsWith('Installation — '),
    );
    expect(installItem).toBeTruthy();
    expect(Number(installItem!.unitCost)).toBe(4 * 95); // 380 (hourly_rate_cost null → $95 setting)
    expect(Number(installItem!.unitSell)).toBe(sellAtMargin(380));
  });

  it('install-method labour feeds the out-of-hours uplift hours', async () => {
    const outOfHours = await prisma.serviceHoursOption.findFirst({ where: { name: { not: 'Business Hours' } } });
    expect(outOfHours).toBeTruthy();
    const quoteId = await newQuote('instooh');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD install OOH',
        installMethodId: Number(installMethodId),
        serviceHoursId: Number(outOfHours!.id),
        items: [],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;

    // install-method labour cost = 380 → uplift hours = 380 / 95 = 4 → cost = 4×$50, sell = 4×$80.
    const uplift = screen.items.find((i) => (i.description ?? '').startsWith('Out of Hours uplift'));
    expect(uplift).toBeTruthy();
    expect((uplift!.description ?? '')).toContain('4 hrs');
    expect(Number(uplift!.unitCost)).toBe(4 * 50); // 200
    expect(Number(uplift!.unitSell)).toBe(4 * 80); // 320
  });
});

describe('X2 — re-edit does not duplicate auto lines', () => {
  it('PUT resending items keeps exactly one warranty / install / OOH line', async () => {
    const outOfHours = await prisma.serviceHoursOption.findFirst({ where: { name: { not: 'Business Hours' } } });
    const quoteId = await newQuote('dedup');
    const created = (await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD dedup',
        warrantyId: Number(extendedWarrantyId),
        installMethodId: Number(installMethodId),
        serviceHoursId: Number(outOfHours!.id),
        items: [],
      },
    })).json() as LcdScreenJson;

    // Sanity: exactly one of each auto line after create.
    const countAuto = (s: LcdScreenJson) => ({
      warranty: s.items.filter((i) => i.itemType === 'warranty').length,
      install: s.items.filter((i) => i.itemType === 'install' && (i.description ?? '').startsWith('Installation — ')).length,
      ooh: s.items.filter((i) => (i.description ?? '').startsWith('Out of Hours uplift')).length,
    });
    expect(countAuto(created)).toEqual({ warranty: 1, install: 1, ooh: 1 });

    // Re-edit: resend the SAME (server-generated) items back to the PUT endpoint.
    const put = await app.inject({
      method: 'PUT',
      url: `/quotes/${quoteId}/lcd-screens/${created.id}`,
      headers: auth(),
      payload: {
        screenName: 'LCD dedup',
        warrantyId: Number(extendedWarrantyId),
        installMethodId: Number(installMethodId),
        serviceHoursId: Number(outOfHours!.id),
        items: created.items.map((i) => ({
          itemType: i.itemType,
          description: i.description ?? undefined,
          qty: Number(i.qty),
          unitCost: Number(i.unitCost),
          unitSell: Number(i.unitSell),
        })),
      },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json() as LcdScreenJson;
    // The auto lines are stripped + regenerated exactly once — no duplication.
    expect(countAuto(updated)).toEqual({ warranty: 1, install: 1, ooh: 1 });
  });
});
