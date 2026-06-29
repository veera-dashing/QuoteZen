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
