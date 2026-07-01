import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Block: full governance rule-set capture into an immutable version snapshot.
 *
 * Verifies `captureRuleSet` (via POST /quotes/:id/versions → GET /quotes/:id/versions/:rev) records
 * the extended Z-series governance: margin bands, discount policy + the quote's resolved discount,
 * client tier, the anomaly-rule table, financial bumpers, and manufacturer priorities — in addition
 * to the original markups/freight/addOns/rates/marginFloor.
 */
const JOB_PREFIX = `TESTVRS-${process.pid}-`;
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

// Settings we mutate to assert exact capture — restored in afterAll.
const MUTATED_KEYS = ['min_gross_margin', 'walk_away_margin'] as const;
const original: Record<string, string | null> = {};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;

  for (const key of MUTATED_KEYS) {
    const row = await prisma.setting.findUnique({ where: { key } });
    original[key] = row ? String(row.value) : null;
  }
});

afterAll(async () => {
  // Restore mutated settings to their original values (or remove if they didn't exist).
  for (const key of MUTATED_KEYS) {
    const prev = original[key];
    if (prev == null) {
      await prisma.setting.deleteMany({ where: { key } });
    } else {
      await prisma.setting.update({ where: { key }, data: { value: prev } });
    }
  }
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const loadRuleSet = async (quoteId: string) => {
  const snap = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/versions/1`, headers: auth() });
  expect(snap.statusCode).toBe(200);
  return (snap.json() as { snapshot: { ruleSet?: Record<string, unknown> } }).snapshot.ruleSet;
};

describe('full governance rule-set capture (versioning)', () => {
  it('captures margin bands, discount policy, anomaly rules, bumpers, manufacturers + a null clientTier for a client-less quote', async () => {
    // Set known margin-band settings so we can assert exact values in the snapshot.
    await prisma.setting.upsert({
      where: { key: 'min_gross_margin' },
      update: { value: '0.31' },
      create: { key: 'min_gross_margin', label: 'Min Gross Margin', value: '0.31' },
    });
    await prisma.setting.upsert({
      where: { key: 'walk_away_margin' },
      update: { value: '0.19' },
      create: { key: 'walk_away_margin', label: 'Walk-away Margin', value: '0.19' },
    });

    // A quote with NO client (clientTier must snapshot as null).
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}gov-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const v1 = await app.inject({ method: 'POST', url: `/quotes/${id}/versions`, headers: auth(), payload: { label: 'gov' } });
    expect(v1.statusCode).toBe(201);

    const ruleSet = await loadRuleSet(id);
    expect(ruleSet).toBeTruthy();

    // Existing fields still present.
    expect((ruleSet!.markups as { ledMargin: number }).ledMargin).toBeGreaterThan(0);
    expect(typeof ruleSet!.marginFloor).toBe('number');
    expect(typeof ruleSet!.capturedAt).toBe('string');

    // 1. Margin bands — the exact values we just set.
    expect(ruleSet!.minGrossMargin).toBe(0.31);
    expect(ruleSet!.walkAwayMargin).toBe(0.19);

    // 2. Discount policy.
    expect(typeof ruleSet!.discountCapPct).toBe('number');
    expect(typeof ruleSet!.discountNoteThresholdPct).toBe('number');

    // 3. Resolved effective discount for this quote.
    const discount = ruleSet!.discount as { pct: number; source: string; scope: string };
    expect(discount).toBeTruthy();
    expect(typeof discount.pct).toBe('number');
    expect(discount.source).toBeTruthy();
    expect(['one_off', 'recurring']).toContain(discount.scope);

    // 4. Client tier is null (no client on this quote).
    expect(ruleSet!.clientTier).toBeNull();

    // 5. Anomaly rules — non-empty, each row well-shaped.
    const anomalyRules = ruleSet!.anomalyRules as Array<{ key: string; severity: string; enabled: boolean }>;
    expect(Array.isArray(anomalyRules)).toBe(true);
    expect(anomalyRules.length).toBeGreaterThan(0);
    for (const r of anomalyRules) {
      expect(typeof r.key).toBe('string');
      expect(typeof r.severity).toBe('string');
      expect(typeof r.enabled).toBe('boolean');
    }

    // 6. Financial bumpers.
    const bumpers = ruleSet!.financialBumpers as {
      leadTimeBufferDays: number | null;
      audUsdRate: number | null;
      humanInTheLoop: number | null;
    };
    expect(bumpers).toBeTruthy();
    expect('leadTimeBufferDays' in bumpers).toBe(true);
    expect('audUsdRate' in bumpers).toBe(true);
    expect('humanInTheLoop' in bumpers).toBe(true);

    // 7. Manufacturer priorities — include the seeded manufacturers.
    const manufacturers = ruleSet!.manufacturerPriorities as Array<{ name: string; priority: number }>;
    expect(Array.isArray(manufacturers)).toBe(true);
    const seeded = await prisma.manufacturer.findMany();
    if (seeded.length > 0) {
      expect(manufacturers.length).toBe(seeded.length);
      const names = new Set(manufacturers.map((m) => m.name));
      for (const m of seeded) expect(names.has(m.name)).toBe(true);
      for (const m of manufacturers) expect(typeof m.priority).toBe('number');
    }
  });

  it('captures the client tier block when the quote has a tiered client', async () => {
    const tier = await prisma.clientTier.findFirst({ where: { deprecated: false } });
    if (!tier) return; // no tiers seeded — nothing to assert

    const client = await prisma.client.create({
      data: { name: `${JOB_PREFIX}client-${Math.floor(Math.random() * 1e9)}`, tier: tier.name },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}tier-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        clientId: Number(client.id),
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const v1 = await app.inject({ method: 'POST', url: `/quotes/${id}/versions`, headers: auth(), payload: {} });
    expect(v1.statusCode).toBe(201);

    const ruleSet = await loadRuleSet(id);
    const clientTier = ruleSet!.clientTier as {
      name: string;
      preferredFreight: string | null;
      defaultDiscountPct: number | null;
    } | null;
    expect(clientTier).toBeTruthy();
    expect(clientTier!.name).toBe(tier.name);
    expect('preferredFreight' in clientTier!).toBe(true);
    expect('defaultDiscountPct' in clientTier!).toBe(true);

    await prisma.quote.deleteMany({ where: { id: BigInt(id) } });
    await prisma.client.deleteMany({ where: { id: client.id } });
  });
});
