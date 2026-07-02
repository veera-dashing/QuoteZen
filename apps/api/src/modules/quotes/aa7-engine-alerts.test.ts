import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA7 — engine sanity / alerts (workshop Group G). Live-RDS integration.
 *
 * Verifies:
 *  • UNUSUAL_PRICE (warning) fires for an LED screen whose sell $/m² deviates from the historical norm
 *    (median of prior stored screens for the same product), and is ABSENT when a screen is priced in
 *    line with that history / when there is insufficient history;
 *  • CUSTOM_METALWORK_LEAD (info) fires when a screen carries a real custom engineering option and is
 *    absent otherwise;
 *  • neither advisory blocks finalisation (canFinalise stays true).
 *
 * Determinism: uses a product with NO existing quote screens (clean price history) and pitch ≥ 2.5mm
 * (so no GOB_REQUIRED validation error interferes with canFinalise). The history baseline is seeded
 * directly and each test screen's stored priceTotal is set explicitly, so the assertions never depend
 * on the pricing engine's exact output. Self-cleans via a jobReference prefix + the seeded history quote.
 */
const JOB_PREFIX = `TESTAA7-${process.pid}-`;

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

let productId: string;
let cabinetWMm: number;
let cabinetHMm: number;
let historyQuoteId: bigint | null = null;

// Dims used across all AA7 screens (same product) so the baseline is unambiguous.
let wMm: number;
let hMm: number;
let areaSqm: number;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;

  // A fully-specified product with pitch ≥ 2.5mm (no GOB-required error) and NO existing screens, so
  // its price history is entirely what this test seeds.
  const product = await prisma.ledProduct.findFirst({
    where: {
      deprecated: false,
      minCabinetWMm: { not: null },
      minCabinetHMm: { not: null },
      pixelPitchH: { gte: 2.5 },
      pixelPitchV: { not: null },
      costPerSqmUsd: { not: null },
      ledScreens: { none: {} },
    },
    orderBy: { id: 'asc' },
  });
  if (!product) throw new Error('Expected a clean LED product (pitch ≥ 2.5mm, no existing screens)');
  productId = product.id.toString();
  cabinetWMm = product.minCabinetWMm!;
  cabinetHMm = product.minCabinetHMm!;
  wMm = cabinetWMm * 3;
  hMm = cabinetHMm * 3;
  areaSqm = (wMm / 1000) * (hMm / 1000);

  // Seed a HISTORY quote (via the API so createdBy/currency are set) with three prior screens for this
  // product at a controlled baseline of $1000/m² → a clear median of 1000.
  const histCreate = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}HISTORY-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  expect(histCreate.statusCode).toBe(201);
  historyQuoteId = BigInt(histCreate.json().id as string);
  const priceTotal = (1000 * areaSqm).toFixed(2);
  await prisma.quoteLedScreen.createMany({
    data: [0, 1, 2].map((i) => ({
      quoteId: historyQuoteId!,
      screenName: `hist ${i}`,
      ledProductId: BigInt(productId),
      qty: 1,
      sortOrder: i,
      desiredWidthMm: wMm,
      desiredHeightMm: hMm,
      rotateCabinets: false,
      priceTotal,
    })),
  });
});

afterAll(async () => {
  if (historyQuoteId != null) {
    await prisma.quote.delete({ where: { id: historyQuoteId } }).catch(() => undefined);
  }
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const newQuote = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: jobRef(), currencyCode: 'AUD' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};

const addLedScreen = async (
  quoteId: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: `/quotes/${quoteId}/led-screens`,
    headers: auth(),
    payload: { ledProductId: Number(productId), desiredWidthMm: wMm, desiredHeightMm: hMm, rotateCabinets: false, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};

interface Finding { rule: string; severity: string; message: string; screenId?: string }
interface ValidateResp { anomalies: Finding[]; canFinalise: boolean }
const validate = async (quoteId: string): Promise<ValidateResp> => {
  const res = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/validate`, headers: auth() });
  expect(res.statusCode).toBe(200);
  return res.json() as ValidateResp;
};

/** Force a screen's stored priceTotal to a target sell $/m² (bypassing repricing) to control deviation. */
const setScreenPricePerSqm = async (screenId: string, perSqm: number): Promise<void> => {
  await prisma.quoteLedScreen.update({
    where: { id: BigInt(screenId) },
    data: { priceTotal: (perSqm * areaSqm).toFixed(2) },
  });
};

describe('AA7 — UNUSUAL_PRICE advisory (warning, never blocks)', () => {
  it('fires when the screen $/m² deviates far from the product history baseline', async () => {
    const id = await newQuote();
    const screenId = await addLedScreen(id);
    // History median $/m² is 1000; push this screen to 2000/m² (100% deviation, > 30% threshold).
    await setScreenPricePerSqm(screenId, 2000);
    const v = await validate(id);
    const up = v.anomalies.find((a) => a.rule === 'UNUSUAL_PRICE');
    expect(up).toBeDefined();
    expect(up?.severity).toBe('warning');
    expect(up?.screenId).toBe(screenId);
    // Advisory-only — must NOT block finalisation (product is pitch ≥ 2.5mm so no GOB error either).
    expect(v.canFinalise).toBe(true);
  });

  it('does NOT fire when the screen $/m² is in line with the history baseline', async () => {
    const id = await newQuote();
    const screenId = await addLedScreen(id);
    // Same $/m² as the seeded history (1000) → within threshold → no finding.
    await setScreenPricePerSqm(screenId, 1000);
    const v = await validate(id);
    expect(v.anomalies.find((a) => a.rule === 'UNUSUAL_PRICE')).toBeUndefined();
    expect(v.canFinalise).toBe(true);
  });

  it('does NOT fire with insufficient history (a product with no priors)', async () => {
    // A product with no seeded history rows → fewer than 2 comparable priors → skip (never a warning).
    const orphan = await prisma.ledProduct.findFirst({
      where: {
        deprecated: false,
        id: { not: BigInt(productId) },
        minCabinetWMm: { not: null },
        minCabinetHMm: { not: null },
        pixelPitchH: { gte: 2.5 },
        pixelPitchV: { not: null },
        costPerSqmUsd: { not: null },
        ledScreens: { none: {} },
      },
      orderBy: { id: 'desc' },
    });
    if (!orphan) return; // no clean orphan product available → skip rather than assert falsely
    const id = await newQuote();
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/led-screens`,
      headers: auth(),
      payload: {
        ledProductId: Number(orphan.id),
        desiredWidthMm: (orphan.minCabinetWMm ?? 500) * 3,
        desiredHeightMm: (orphan.minCabinetHMm ?? 500) * 3,
        rotateCabinets: false,
      },
    });
    expect(res.statusCode).toBe(201);
    const v = await validate(id);
    expect(v.anomalies.find((a) => a.rule === 'UNUSUAL_PRICE')).toBeUndefined();
  });
});

describe('AA7 — CUSTOM_METALWORK_LEAD advisory (info, never blocks)', () => {
  it('fires when a screen carries a real custom engineering option', async () => {
    const engineering = (await prisma.engineeringOption.findMany({ orderBy: { id: 'asc' } })).find(
      (e) => !/no engineering/i.test(e.name),
    );
    if (!engineering) throw new Error('Expected a non-"No Engineering" engineering option in the catalogue');
    const id = await newQuote();
    const screenId = await addLedScreen(id, { engineeringId: Number(engineering.id) });
    // Keep the price in line with history so UNUSUAL_PRICE doesn't add noise; canFinalise stays clean.
    await setScreenPricePerSqm(screenId, 1000);
    const v = await validate(id);
    const cm = v.anomalies.find((a) => a.rule === 'CUSTOM_METALWORK_LEAD');
    expect(cm).toBeDefined();
    expect(cm?.severity).toBe('info');
    expect(cm?.message.toLowerCase()).toContain('lead time');
    // Advisory info — must NOT block finalisation.
    expect(v.canFinalise).toBe(true);
  });

  it('is absent when no custom metalwork is involved', async () => {
    const id = await newQuote();
    const screenId = await addLedScreen(id); // plain screen, no engineering
    await setScreenPricePerSqm(screenId, 1000);
    const v = await validate(id);
    expect(v.anomalies.find((a) => a.rule === 'CUSTOM_METALWORK_LEAD')).toBeUndefined();
    expect(v.canFinalise).toBe(true);
  });
});
