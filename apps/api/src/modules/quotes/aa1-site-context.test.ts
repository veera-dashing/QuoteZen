import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA1 — site/context intake fields. Verifies the 5 quote-level site-context fields round-trip through
 * create → GET, and that the per-screen fields (`recessDepthMm`, `sunExposure`, `wallSubstrate`)
 * persist on both an LED and an LCD screen. Sun exposure and wall substrate are per-screen, not
 * per-quote: one site can hold a shaded screen on plasterboard and a west-facing one on brick, so a
 * single quote-level value could not describe both.
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
  powerDataAvailable: 'Unknown',
  controllerLocation: 'comms room, level 2',
  windowFacing: true,
} as const;

describe('AA1 — site/context intake fields', () => {
  it('round-trips the 5 quote-level site-context fields through create → GET', async () => {
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
      payload: { expectedVersion: lockVersion, controllerLocation: 'plant room, level 3', endCustomer: null, windowFacing: false },
    });
    expect(patched.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    const q = got.json();
    expect(q.controllerLocation).toBe('plant room, level 3');
    expect(q.endCustomer).toBeNull();
    expect(q.windowFacing).toBe(false);
    // Untouched field stays.
    expect(q.airsideLandside).toBe(SITE_CONTEXT.airsideLandside);
  });

  it('persists recessDepthMm + per-screen sunExposure/wallSubstrate on an LED and an LCD screen', async () => {
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
        sunExposure: 'Direct',
        wallSubstrate: 'brick',
      },
    });
    expect(led.statusCode).toBe(201);
    expect(led.json().recessDepthMm).toBe(85);
    expect(led.json().sunExposure).toBe('Direct');
    expect(led.json().wallSubstrate).toBe('brick');

    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'Foyer board',
        recessDepthMm: 120,
        // Deliberately different from the LED screen above: the point of moving this field off the
        // quote is that two screens on ONE site can disagree.
        sunExposure: 'None',
        wallSubstrate: 'plasterboard over steel stud',
        items: [{ itemType: 'display', displayId: Number(display!.id), qty: 1 }],
      },
    });
    expect(lcd.statusCode).toBe(201);
    expect(lcd.json().recessDepthMm).toBe(120);
    expect(lcd.json().sunExposure).toBe('None');
    expect(lcd.json().wallSubstrate).toBe('plasterboard over steel stud');

    // Confirm both persisted (re-read via GET quote).
    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    const q = got.json();
    expect(q.ledScreens[0].recessDepthMm).toBe(85);
    expect(q.lcdScreens[0].recessDepthMm).toBe(120);
    expect(q.ledScreens[0].sunExposure).toBe('Direct');
    expect(q.lcdScreens[0].sunExposure).toBe('None');
    expect(q.ledScreens[0].wallSubstrate).toBe('brick');
    expect(q.lcdScreens[0].wallSubstrate).toBe('plasterboard over steel stud');
  });
});
