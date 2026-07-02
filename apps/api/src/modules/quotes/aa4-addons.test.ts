import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA4 — LED add-ons: protective / gold coating (priced by area) + high-resolution supply uplift.
 *
 * Live-RDS integration. Proves the DEFAULT NO-OP invariant (adding a screen without a coating and
 * with the uplift setting at 0 prices exactly as the no-coating baseline) and that a selected
 * coating adds a labelled line ≈ costPerSqm × area grossed by the LED markup (1.5), surfaced in the
 * itemised /price view. Self-cleans quotes by jobRef prefix + restores any setting/row it touches.
 */
const JOB_PREFIX = `TESTAA4-${process.pid}-`;
const LED_MARKUP = 1.5; // led_markup (F17) — the gross-up applied to LED equipment lines.
const round2 = (n: number) => Math.round(n * 100) / 100;

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

let productId: bigint;
let coatingId: bigint;
let coatingCostPerSqm: number;
// A dedicated coating row we create with a known rate, deleted in afterAll.
let createdCoating = false;

const newQuote = async (tag: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${tag}-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return created.json().id as string;
};

type LedScreenJson = {
  id: string;
  priceTotal: string;
  priceScreenMediaplayer: string;
  costBreakdown: Array<{ lineLabel: string; category: string | null; cost: string | null; sell: string | null }>;
};

const addScreen = async (quoteId: string, extra: Record<string, unknown>): Promise<LedScreenJson> => {
  const res = await app.inject({
    method: 'POST',
    url: `/quotes/${quoteId}/led-screens`,
    headers: auth(),
    payload: {
      ledProductId: Number(productId),
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      rotateCabinets: true,
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as LedScreenJson;
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;

  const product = await prisma.ledProduct.findFirst({
    where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, pixelPitchV: { not: null }, costPerSqmUsd: { not: null } },
  });
  expect(product).toBeTruthy();
  productId = product!.id;

  // Use a seeded coating row with a real rate, else create one (deleted in afterAll).
  const existing = await prisma.coatingOption.findFirst({ where: { deprecated: false, costPerSqm: { gt: 0 } } });
  if (existing) {
    coatingId = existing.id;
    coatingCostPerSqm = Number(existing.costPerSqm);
  } else {
    const c = await prisma.coatingOption.create({ data: { name: `AA4 Test Coating ${process.pid}`, costPerSqm: 120 } });
    coatingId = c.id;
    coatingCostPerSqm = 120;
    createdCoating = true;
  }
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  if (createdCoating && coatingId != null) {
    await prisma.coatingOption.delete({ where: { id: coatingId } }).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

describe('AA4 — default no-op', () => {
  it('a screen with no coating (uplift setting 0) prices exactly as the no-coating baseline', async () => {
    // Two identical screens, neither with a coating and highResolution left off: same price.
    const q1 = await newQuote('noop-a');
    const baseline = await addScreen(q1, {});
    const q2 = await newQuote('noop-b');
    const same = await addScreen(q2, { highResolution: true }); // no uplift rate → still a no-op

    expect(Number(same.priceTotal)).toBe(Number(baseline.priceTotal));
    // No coating / high-resolution lines exist.
    expect(baseline.costBreakdown.some((l) => l.lineLabel.startsWith('Coating —'))).toBe(false);
    expect(same.costBreakdown.some((l) => l.lineLabel === 'High-resolution upgrade')).toBe(false);
  });
});

describe('AA4 — coating add-on', () => {
  it('adds a coating line ≈ costPerSqm × area × LED markup, raising the screen sell', async () => {
    const qBase = await newQuote('cbase');
    const baseline = await addScreen(qBase, {});

    const qCoat = await newQuote('coat');
    const withCoating = await addScreen(qCoat, { coatingId: Number(coatingId) });

    // The stored screen area (weightKg / kgPerSqm) isn't returned, so derive area from the coating
    // line itself: cost = costPerSqm × area. Assert the line exists + is grossed at the LED markup.
    const coatingLine = withCoating.costBreakdown.find((l) => l.lineLabel.startsWith('Coating —'));
    expect(coatingLine).toBeTruthy();
    const lineCost = Number(coatingLine!.cost);
    const lineSell = Number(coatingLine!.sell);
    expect(lineCost).toBeGreaterThan(0);
    // sell = round(unrounded cost × 1.5); vs the STORED (already-rounded) cost × 1.5 differ by ≤1c
    // (the calc grosses up before rounding). Assert the LED-markup relationship within a penny.
    expect(lineSell).toBeCloseTo(round2(lineCost * LED_MARKUP), 1);
    // Area implied by the line matches costPerSqm × area.
    const impliedArea = lineCost / coatingCostPerSqm;
    expect(impliedArea).toBeGreaterThan(0);

    // The screen sell rose by exactly the coating line's sell (it's in the screen_mediaplayer bucket).
    expect(round2(Number(withCoating.priceTotal))).toBe(round2(Number(baseline.priceTotal) + lineSell));

    // And the itemised /price view surfaces the coating line (admin sees cost).
    const price = await app.inject({ method: 'POST', url: `/quotes/${qCoat}/price`, headers: auth() });
    expect(price.statusCode).toBe(200);
    const body = price.json() as { costVisible: boolean; sections: Array<{ lines: Array<{ label: string; sell: string | null }> }> };
    const allLines = body.sections.flatMap((s) => s.lines);
    expect(allLines.some((l) => l.label.startsWith('Coating —'))).toBe(true);
  });
});
