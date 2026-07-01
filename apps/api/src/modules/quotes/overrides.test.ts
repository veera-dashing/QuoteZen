import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * P1-17 manual price overrides (pinned-override recalc). Integration tests against the live DB.
 * Self-cleaning via the job-reference prefix; restores margin_floor to its seeded value afterwards.
 */
const JOB_PREFIX = `TESTOVR-${process.pid}-`;
let app: FastifyInstance;
let token: string;
let salesToken: string;
const auth = () => ({ authorization: `Bearer ${token}` });
const sales = () => ({ authorization: `Bearer ${salesToken}` });

const ledProduct = () =>
  prisma.ledProduct.findFirst({
    where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
  });

/** Create a quote owned by `headers` with one priced LED screen; returns { quoteId, screenId, unit }. */
const newQuoteWithScreen = async (headers: Record<string, string>) => {
  const product = await ledProduct();
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers,
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  const quoteId = created.json().id as string;
  const led = await app.inject({
    method: 'POST',
    url: `/quotes/${quoteId}/led-screens`,
    headers,
    payload: { screenName: 'Override screen', ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  const screen = led.json();
  return { quoteId, screenId: screen.id as string, unit: Number(screen.priceTotal) };
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const a = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@quotezen.local', password: 'demo' } });
  token = a.json().token as string;
  const s = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'sales@quotezen.local', password: 'demo' } });
  salesToken = s.json().token as string;
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

describe('manual price overrides (P1-17)', () => {
  it('pins an override into the rollup, flags it downstream, and reverts on clear', async () => {
    const { quoteId, screenId, unit } = await newQuoteWithScreen(auth());
    expect(unit).toBeGreaterThan(0);

    // Baseline: equipment == the computed per-unit price.
    const baseline = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/recompute`, headers: auth() });
    expect(Number(baseline.json().totalEquipment)).toBeCloseTo(unit, 2);

    // Set an override to a clearly different sell value.
    const overrideValue = Math.round((unit + 5000) * 100) / 100;
    const set = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/overrides`,
      headers: auth(),
      payload: { targetType: 'led_screen_price', targetId: Number(screenId), value: overrideValue, reason: 'Customer-negotiated price' },
    });
    expect(set.statusCode).toBe(200);
    const setBody = set.json() as { override: { originalValue: string; overrideValue: string }; quote: { totalEquipment: string } };
    // originalValue captured the computed value; the pinned value rolled into equipment.
    expect(Number(setBody.override.originalValue)).toBeCloseTo(unit, 2);
    expect(Number(setBody.override.overrideValue)).toBeCloseTo(overrideValue, 2);
    expect(Number(setBody.quote.totalEquipment)).toBeCloseTo(overrideValue, 2);

    // priceQuote flags the affected section + lists the active override.
    const priced = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() });
    const pBody = priced.json() as {
      hasOverrides: boolean;
      overrides: Array<{ targetId: string }>;
      sections: Array<{ type: string; overridden?: boolean; total: string; computedTotal?: string; targetId?: string }>;
      totals: { equipment: string };
    };
    expect(pBody.hasOverrides).toBe(true);
    expect(pBody.overrides.some((o) => o.targetId === String(screenId))).toBe(true);
    const led = pBody.sections.find((s) => s.type === 'led' && s.targetId === String(screenId));
    expect(led?.overridden).toBe(true);
    expect(Number(led?.total)).toBeCloseTo(overrideValue, 2);
    expect(Number(led?.computedTotal)).toBeCloseTo(unit, 2);
    expect(Number(pBody.totals.equipment)).toBeCloseTo(overrideValue, 2);

    // GET /overrides returns the active override.
    const list = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/overrides`, headers: auth() });
    const overrides = list.json() as Array<{ id: string; targetId: string; reason: string | null }>;
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.reason).toBe('Customer-negotiated price');
    const overrideId = overrides[0]!.id;

    // Audit recorded the set.
    const audit = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/audit`, headers: auth() });
    expect((audit.json() as Array<{ entityTable: string }>).some((r) => r.entityTable === 'quote_overrides')).toBe(true);

    // Clear → equipment reverts to the computed value, no active overrides.
    const cleared = await app.inject({ method: 'DELETE', url: `/quotes/${quoteId}/overrides/${overrideId}`, headers: auth() });
    expect(cleared.statusCode).toBe(200);
    expect(Number(cleared.json().totalEquipment)).toBeCloseTo(unit, 2);
    const after = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/overrides`, headers: auth() });
    expect((after.json() as unknown[]).length).toBe(0);
  });

  it('rejects a negative override value with 400', async () => {
    const { quoteId, screenId } = await newQuoteWithScreen(auth());
    const bad = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/overrides`,
      headers: auth(),
      payload: { targetType: 'led_screen_price', targetId: Number(screenId), value: -1 },
    });
    expect([400, 422]).toContain(bad.statusCode);
  });

  it('a below-floor override blocks non-admin finalisation but admin can override (audited)', async () => {
    // Sales-owned quote with a priced screen; force the floor high.
    const { quoteId, screenId, unit } = await newQuoteWithScreen(sales());
    await prisma.setting.update({ where: { key: 'margin_floor' }, data: { value: 0.2 } });

    // Override the sell DOWN to $1 → margin collapses below the floor; warning returned.
    const set = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/overrides`,
      headers: sales(),
      payload: { targetType: 'led_screen_price', targetId: Number(screenId), value: 1, reason: 'loss leader' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { warning: string | null }).warning).toMatch(/below the floor/i);
    expect(unit).toBeGreaterThan(1);

    // Sales finalisation blocked (margin reflects the override → below the 22% walk-away floor → Z3).
    const blocked = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/status`, headers: sales(), payload: { status: 'approved' } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/walk-away floor. Director approval required/);

    // Admin can finalise the same quote (admin sees all), and the override is audited.
    const allowed = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/status`, headers: auth(), payload: { status: 'approved' } });
    expect(allowed.statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/audit`, headers: auth() });
    expect((audit.json() as Array<{ fieldName: string | null }>).some((a) => a.fieldName === 'margin_guardrail')).toBe(true);
  });
});
