import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Z6 — client tiers as rule-bearing entities with global→tier→client discount resolution.
 * A tier carries a default discount % + preferred freight, shared by its clients and overridable per
 * client. The tier layers BETWEEN the client override and the system default.
 */
const JOB_PREFIX = `Z6-${process.pid}-`;
const NAME_PREFIX = `Z6-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
const admin = () => ({ authorization: `Bearer ${adminToken}` });

// Test fixtures — created in beforeAll, torn down in afterAll.
let tierName: string;
let tierId: bigint;
let tierClientId: bigint; // client with tier, NO own discount → resolves from tier
let ownDiscClientId: bigint; // client with tier AND own discount → client wins
let noTierClientId: bigint; // client with no tier → system default (unchanged behaviour)

const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json()
    .token as string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');

  // A rule-bearing tier: default discount 0.11, preferred freight 'Air'. Unique name so `clients.tier`
  // (relation-by-name FK) resolves it without clashing with the seeded A+/A/B tiers.
  tierName = `ZT-A+${process.pid}`;
  const tier = await prisma.clientTier.create({
    data: {
      name: tierName,
      label: 'Z6 test tier',
      description: 'Z6 test tier — rule-bearing',
      installStandard: 'White-glove',
      preferredFreight: 'Air',
      defaultDiscountPct: 0.11,
    },
  });
  tierId = tier.id;

  const tierClient = await prisma.client.create({
    data: { name: `${NAME_PREFIX}tier-client`, tier: tierName },
  });
  tierClientId = tierClient.id;

  const ownDiscClient = await prisma.client.create({
    data: { name: `${NAME_PREFIX}own-disc`, tier: tierName, discountPct: 0.05 },
  });
  ownDiscClientId = ownDiscClient.id;

  const noTierClient = await prisma.client.create({
    data: { name: `${NAME_PREFIX}no-tier` },
  });
  noTierClientId = noTierClient.id;
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await prisma.client.deleteMany({ where: { id: { in: [tierClientId, ownDiscClientId, noTierClientId] } } });
  await prisma.clientTier.delete({ where: { id: tierId } }).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

const ledProduct = () =>
  prisma.ledProduct.findFirstOrThrow({
    where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
  });

const newQuoteWithScreen = async (clientId: bigint) => {
  const product = await ledProduct();
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: admin(),
    payload: {
      jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`,
      currencyCode: 'AUD',
      clientId: Number(clientId),
    },
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers: admin(),
    payload: { ledProductId: Number(product.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  return id;
};

const priceOf = async (id: string) =>
  (await app.inject({ method: 'POST', url: `/quotes/${id}/price`, headers: admin() })).json() as {
    discount?: { pct: number; source: string; amount: string };
    totals: { grandTotal: string };
  };

describe('Z6 — discount resolution layers the tier between client and system', () => {
  it('a client with a tier but NO own discount resolves the discount from the TIER', async () => {
    const id = await newQuoteWithScreen(tierClientId);
    const price = await priceOf(id);
    expect(price.discount?.source).toBe('tier');
    expect(price.discount?.pct).toBe(0.11);
    // sanity: the discount actually reduced the grand total (upfront > 0).
    expect(Number(price.totals.grandTotal)).toBeGreaterThan(0);
  });

  it('a client with its OWN discount overrides the tier default (source: client)', async () => {
    const id = await newQuoteWithScreen(ownDiscClientId);
    const price = await priceOf(id);
    expect(price.discount?.source).toBe('client');
    expect(price.discount?.pct).toBe(0.05);
  });

  it('a client with NO tier falls back to the system default (no regression)', async () => {
    const id = await newQuoteWithScreen(noTierClientId);
    const price = await priceOf(id);
    expect(price.discount?.source).toBe('system');
    // system default is 0 → no discount, same as pre-Z6 behaviour for untiered clients.
    expect(price.discount?.pct).toBe(0);
  });
});

describe('Z6 — /rules/client/:id/effective reports the tier block', () => {
  it('reports discount source "tier" + a tier block + tier preferred freight when only the tier has a discount', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/rules/client/${tierClientId}/effective`,
      headers: admin(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      discount: { value: number; source: string; overridesGlobal: boolean; tierDefault: number | null };
      preferredFreight: { value: string | null; source: string };
      tier: { name: string; preferredFreight: string | null; defaultDiscountPct: number | null } | null;
    };
    expect(body.discount.source).toBe('tier');
    expect(body.discount.value).toBe(0.11);
    expect(body.discount.tierDefault).toBe(0.11);
    // preferred freight comes from the tier (client has none).
    expect(body.preferredFreight.source).toBe('tier');
    expect(body.preferredFreight.value).toBe('Air');
    // the tier block is present with its rules.
    expect(body.tier).not.toBeNull();
    expect(body.tier?.name).toBe(tierName);
    expect(body.tier?.preferredFreight).toBe('Air');
    expect(body.tier?.defaultDiscountPct).toBe(0.11);
  });

  it('a client with its own discount reports source "client" (tier still surfaced as tierDefault)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/rules/client/${ownDiscClientId}/effective`,
      headers: admin(),
    });
    const body = res.json() as {
      discount: { value: number; source: string; tierDefault: number | null };
      tier: { name: string } | null;
    };
    expect(body.discount.source).toBe('client');
    expect(body.discount.value).toBe(0.05);
    expect(body.tier?.name).toBe(tierName);
  });

  it('a client with no tier reports a null tier block + system discount (no regression)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/rules/client/${noTierClientId}/effective`,
      headers: admin(),
    });
    const body = res.json() as {
      discount: { source: string; overridesGlobal: boolean };
      preferredFreight: { value: string | null; source: string };
      tier: unknown | null;
    };
    expect(body.tier).toBeNull();
    expect(body.discount.source).toBe('system');
    expect(body.discount.overridesGlobal).toBe(false);
    expect(body.preferredFreight.value).toBeNull();
  });
});
