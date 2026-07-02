import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA1 — site/context intake fields. Verifies the 7 quote-level site-context fields round-trip through
 * create → GET, and that per-screen `recessDepthMm` persists on both an LED and an LCD screen.
 *
 * Live-RDS integration; self-cleans via a jobReference prefix.
 */
const JOB_PREFIX = `TESTAA1-${process.pid}-`;

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

const SITE_CONTEXT = {
  endCustomer: 'Airport Retailer Pty Ltd',
  airsideLandside: 'Airside',
  sunExposure: 'Direct',
  wallSubstrate: 'plasterboard over steel stud',
  powerDataAvailable: 'Unknown',
  controllerLocation: 'comms room, level 2',
  windowFacing: true,
} as const;

describe('AA1 — site/context intake fields', () => {
  it('round-trips the 7 quote-level site-context fields through create → GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}Q-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        ...SITE_CONTEXT,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    const q = got.json();
    expect(q.endCustomer).toBe(SITE_CONTEXT.endCustomer);
    expect(q.airsideLandside).toBe(SITE_CONTEXT.airsideLandside);
    expect(q.sunExposure).toBe(SITE_CONTEXT.sunExposure);
    expect(q.wallSubstrate).toBe(SITE_CONTEXT.wallSubstrate);
    expect(q.powerDataAvailable).toBe(SITE_CONTEXT.powerDataAvailable);
    expect(q.controllerLocation).toBe(SITE_CONTEXT.controllerLocation);
    expect(q.windowFacing).toBe(true);
  });

  it('updates (PATCH) and clears the site-context fields', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}QU-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD', ...SITE_CONTEXT },
    });
    const id = created.json().id as string;
    const lockVersion = created.json().lockVersion as number;

    // Change one, clear another (nullish on update).
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: auth(),
      payload: { expectedVersion: lockVersion, sunExposure: 'Indirect', endCustomer: null, windowFacing: false },
    });
    expect(patched.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    const q = got.json();
    expect(q.sunExposure).toBe('Indirect');
    expect(q.endCustomer).toBeNull();
    expect(q.windowFacing).toBe(false);
    // Untouched field stays.
    expect(q.airsideLandside).toBe(SITE_CONTEXT.airsideLandside);
  });

  it('persists recessDepthMm on an LED screen and an LCD screen', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { deprecated: false, minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    expect(product).toBeTruthy();
    const display = await prisma.displayCatalog.findFirst({
      where: { deprecated: false, totalCost: { not: null }, sell: { not: null } },
    });
    expect(display).toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}QS-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;

    const led = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/led-screens`,
      headers: auth(),
      payload: {
        ledProductId: Number(product!.id),
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        rotateCabinets: true,
        recessDepthMm: 85,
      },
    });
    expect(led.statusCode).toBe(201);
    expect(led.json().recessDepthMm).toBe(85);

    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'Foyer board',
        recessDepthMm: 120,
        items: [{ itemType: 'display', displayId: Number(display!.id), qty: 1 }],
      },
    });
    expect(lcd.statusCode).toBe(201);
    expect(lcd.json().recessDepthMm).toBe(120);

    // Confirm both persisted (re-read via GET quote).
    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    const q = got.json();
    expect(q.ledScreens[0].recessDepthMm).toBe(85);
    expect(q.lcdScreens[0].recessDepthMm).toBe(120);
  });
});
