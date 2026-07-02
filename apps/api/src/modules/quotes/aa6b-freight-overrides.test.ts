import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA6b — region/product freight overrides (workshop rule #18). Live-RDS integration.
 *
 * Proves:
 *   1. baseline LED screen price with NO override (strict no-op path);
 *   2. a matching override (by the quote's location) → re-price the SAME screen → the freight/services
 *      change to reflect the flat per-screen rate and a "Freight override" line appears in `/price`;
 *   3. a NON-matching override (different location) → price unchanged.
 *
 * Self-cleans: deletes the freight_overrides rows it created + its quotes in afterAll.
 */
const JOB_PREFIX = `TESTAA6B-${process.pid}-`;
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const createdOverrideIds: bigint[] = [];

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
  if (createdOverrideIds.length > 0) {
    await prisma.freightOverride.deleteMany({ where: { id: { in: createdOverrideIds } } });
  }
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

/** Services (freight) is on the LED screen's `priceServices` column + the "Install, labour & freight" line. */
const servicesLine = (priceBody: {
  sections: Array<{ type: string; lines: Array<{ label: string; cost: string | null; sell: string | null }> }>;
}) => priceBody.sections.find((s) => s.type === 'led')!.lines.find((l) => /Install, labour & freight/.test(l.label))!;

describe('AA6b — region/product freight overrides', () => {
  it('baseline (no override) → matching override → non-matching override', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: {
        minCabinetWMm: { not: null },
        pixelPitchH: { not: null },
        costPerSqmUsd: { not: null },
        kgPerSqm: { not: null },
        manufacturerId: { not: null }, // need a manufacturer to prove the product-family match dimension
      },
    });
    expect(product).toBeTruthy();

    // Two distinct locations so we can build a matching + a non-matching override.
    const locations = await prisma.location.findMany({ take: 2, orderBy: { id: 'asc' } });
    expect(locations.length).toBeGreaterThanOrEqual(2);
    const quoteLocation = locations[0]!;
    const otherLocation = locations[1]!;

    // A quote at quoteLocation with a freight option selected so there IS weight-based freight to replace.
    const freightOpt = await prisma.freightOption.findFirst({ where: { deprecated: false, rate: { gt: 0 } } });
    expect(freightOpt).toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}Q-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        locationId: Number(quoteLocation.id),
      },
    });
    expect(created.statusCode).toBe(201);
    const quoteId = created.json().id as string;

    const ledPayload = {
      screenName: 'AA6b screen',
      ledProductId: Number(product!.id),
      qty: 1,
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      rotateCabinets: true,
      freightOptionId: Number(freightOpt!.id),
    };
    const led = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/led-screens`,
      headers: auth(),
      payload: ledPayload,
    });
    expect(led.statusCode).toBe(201);
    const screen = led.json();
    const screenId = screen.id as string;

    // ── (1) baseline price, no override ──
    const baseline = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() });
    expect(baseline.statusCode).toBe(200);
    const baseBody = baseline.json();
    const baseServices = servicesLine(baseBody);
    // No override yet → no "Freight override" label anywhere.
    const hasOverrideLine = (b: typeof baseBody) =>
      b.sections.some((s: { lines: Array<{ label: string }> }) => s.lines.some((l) => /Freight override/i.test(l.label)));
    expect(hasOverrideLine(baseBody)).toBe(false);
    const baseSell = Number(baseServices.sell);
    const baseCost = Number(baseServices.cost);
    expect(baseSell).toBeGreaterThan(0);

    // ── (2) matching override (by the quote's location) → re-price the SAME screen ──
    const ratePerScreen = 90;
    const match = await prisma.freightOverride.create({
      data: { locationId: quoteLocation.id, ratePerScreenAud: ratePerScreen.toString(), note: 'Free to depot, $90/screen' },
    });
    createdOverrideIds.push(match.id);

    // Re-price the same screen (PATCH with empty body re-runs computeLedScreenPricing).
    const rePrice = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}/led-screens/${screenId}`,
      headers: auth(),
      payload: {},
    });
    expect(rePrice.statusCode).toBe(200);

    const afterMatch = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() });
    const matchBody = afterMatch.json();
    expect(hasOverrideLine(matchBody)).toBe(true); // the "Freight override" line appears
    const matchServices = servicesLine(matchBody);
    // The services cost/sell changed (flat rate replaced the weight-based freight).
    expect(Number(matchServices.cost)).not.toBe(baseCost);
    expect(Number(matchServices.sell)).not.toBe(baseSell);

    // Verify the exact freight math: services now includes freight = rate (90), not weight×freightRate.
    // Re-derive the non-freight services cost and confirm services = nonFreight + rate.
    // The install line cost = markupable(labour + access + freight) + engineering. With no access/eng
    // here, cost = labour + freight. So baseCost - override rate delta = labour, and matchCost = labour + 90.
    // We assert the direction + the flat contribution rather than reconstructing labour independently:
    // matchCost should equal baseCost - weightFreight + 90.
    const freightKg = Number(screen.freightKg);
    const weightFreight = freightKg * Number(freightOpt!.rate);
    expect(weightFreight).toBeGreaterThan(0);
    expect(Number(matchServices.cost)).toBeCloseTo(baseCost - weightFreight + ratePerScreen, 2);

    // ── (3) a NON-matching override (different location) → price unchanged ──
    // Deprecate the matching row and add one scoped to a DIFFERENT location; the screen should revert
    // to the weight-based baseline.
    await prisma.freightOverride.update({ where: { id: match.id }, data: { deprecated: true } });
    const nonMatch = await prisma.freightOverride.create({
      data: { locationId: otherLocation.id, ratePerScreenAud: '999.00', note: 'Other region' },
    });
    createdOverrideIds.push(nonMatch.id);

    const rePrice2 = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}/led-screens/${screenId}`,
      headers: auth(),
      payload: {},
    });
    expect(rePrice2.statusCode).toBe(200);

    const afterNonMatch = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() });
    const nonMatchBody = afterNonMatch.json();
    expect(hasOverrideLine(nonMatchBody)).toBe(false); // back to the plain label
    const nonMatchServices = servicesLine(nonMatchBody);
    expect(Number(nonMatchServices.cost)).toBeCloseTo(baseCost, 2);
    expect(Number(nonMatchServices.sell)).toBeCloseTo(baseSell, 2);
  });
});
