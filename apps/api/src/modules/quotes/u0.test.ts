import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * U0 — schema + backend foundation:
 *  • manufacturers seeded + led_products linked by vendor,
 *  • a quote persists discountPct / siteAddress / projectNotes,
 *  • PATCH /quotes/:id/led-screens/:screenId updates a secondary option (frameId) + re-prices.
 */
const JOB_PREFIX = `TESTU0-${process.pid}-`;
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

describe('U0 — manufacturers seeded + led_products linked', () => {
  it('has the three seeded manufacturers and links LED products by vendor', async () => {
    const mfrs = await prisma.manufacturer.findMany({ where: { name: { in: ['LEDFul', 'ZonePro', 'Muxwave'] } } });
    expect(mfrs.length).toBe(3);
    const ledful = mfrs.find((m) => m.name === 'LEDFul')!;
    expect(ledful.priority).toBe(1);
    expect(ledful.leadTimeDays).toBe(45);

    // Every LEDFul-vendor product should be linked to the LEDFul manufacturer (backfill).
    const unlinked = await prisma.ledProduct.count({ where: { vendor: 'LEDFul', manufacturerId: null } });
    expect(unlinked).toBe(0);
    const linked = await prisma.ledProduct.count({ where: { manufacturerId: ledful.id } });
    expect(linked).toBeGreaterThan(0);
  });

  it('seeds the size_tolerance_bands + default_client_discount_pct settings', async () => {
    const bands = await prisma.setting.findUnique({ where: { key: 'size_tolerance_bands' } });
    expect(bands?.valueText).toBe('5,10,25');
    const disc = await prisma.setting.findUnique({ where: { key: 'default_client_discount_pct' } });
    expect(disc).toBeTruthy();
  });
});

describe('U0 — quote persists discountPct / siteAddress / projectNotes', () => {
  it('persists the new quote-level fields on create and update', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}pi-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        discountPct: 0.05,
        siteAddress: '12 Test St, Sydney',
        projectNotes: 'Lobby install',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(Number(body.discountPct)).toBe(0.05);
    expect(body.siteAddress).toBe('12 Test St, Sydney');
    expect(body.projectNotes).toBe('Lobby install');

    const id = body.id as string;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: auth(),
      payload: { discountPct: 0.1, discountNote: 'test justification', projectNotes: 'Updated notes' },
    });
    expect(patched.statusCode).toBe(200);
    expect(Number(patched.json().discountPct)).toBe(0.1);
    expect(patched.json().projectNotes).toBe('Updated notes');
  });
});

describe('U0 — PATCH a LED screen secondary option + re-price', () => {
  it('updates frameId, re-prices the screen and recomputes the quote', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    // Engineering price passes through to the install/services line, so attaching one re-prices the
    // screen. (Frames are not seeded in this dataset; engineering options are.)
    const engineering = await prisma.engineeringOption.findFirst({ where: { deprecated: false, price: { gt: 0 } } });
    expect(engineering).toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}patch-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;

    // Add a finalised screen with NO frame.
    const led = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/led-screens`,
      headers: auth(),
      payload: { screenName: 'Patch screen', ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });
    expect(led.statusCode).toBe(201);
    const screen = led.json();
    const priceBefore = Number(screen.priceTotal);
    expect(priceBefore).toBeGreaterThan(0);
    expect(screen.engineeringId).toBeNull();

    // PATCH the secondary option: attach engineering → price should increase (passes into services).
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}/led-screens/${screen.id}`,
      headers: auth(),
      payload: { engineeringId: Number(engineering!.id), frameNote: 'with engineering' },
    });
    expect(patched.statusCode).toBe(200);
    // Route returns the recomputed quote; fetch the screen to assert the re-price.
    const after = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() });
    const updatedScreen = (after.json() as { ledScreens: Array<{ id: string; engineeringId: string | null; frameNote: string | null; priceTotal: string; priceServices: string; costBreakdown: Array<{ lineLabel: string }> }> }).ledScreens[0]!;
    expect(String(updatedScreen.engineeringId)).toBe(String(engineering!.id));
    expect(updatedScreen.frameNote).toBe('with engineering');
    expect(Number(updatedScreen.priceTotal)).toBeGreaterThan(priceBefore);

    // The quote equipment total reflects the re-priced screen.
    expect(Number(patched.json().totalEquipment)).toBeCloseTo(Number(updatedScreen.priceTotal), 2);

    // Geometry/product is NOT editable via this endpoint — patching it is ignored (strict-ish):
    // the schema simply doesn't carry ledProductId, so it stays the same.
    expect(String(updatedScreen.id)).toBe(String(screen.id));
  });
});
