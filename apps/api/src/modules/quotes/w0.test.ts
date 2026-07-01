import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * W0 — environment + viewing-distance filtering on the config engine (live RDS).
 *  • POST /quotes/:id/screens/configure with environment=outdoor returns ONLY products whose effective
 *    environment (explicit `environment`, else brightness ≥ outdoor_brightness_nits) is outdoor;
 *  • viewingDistanceM=2 excludes any product with pixel pitch > 2mm (≈1mm : 1m rule);
 *  • every option carries gobRecommended (true iff pitch < 2.5mm) + pixelPitchMm.
 */
const JOB_PREFIX = `TESTW0-${process.pid}-`;
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

const newQuote = async (): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return res.json().id as string;
};

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

interface ConfigRow {
  productId: string;
  pixelPitchMm: number;
  gobRecommended: boolean;
  sizeDeltaPct: string;
}
interface ConfigResp { options: ConfigRow[]; reasons: string[]; toleranceBands: number[] }

const configure = async (
  quoteId: string,
  payload: Record<string, unknown>,
): Promise<ConfigResp> => {
  const res = await app.inject({
    method: 'POST',
    url: `/quotes/${quoteId}/screens/configure`,
    headers: auth(),
    payload,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as ConfigResp;
};

describe('W0 — configure with environment + viewing distance', () => {
  it('environment=outdoor returns only outdoor/bright products; gobRecommended + pitch on every option', async () => {
    const quoteId = await newQuote();
    const threshold = Number((await prisma.setting.findUnique({ where: { key: 'outdoor_brightness_nits' } }))?.value ?? 4000);

    const outdoor = await configure(quoteId, { desiredWidthMm: 1120, desiredHeightMm: 1920, environment: 'outdoor' });
    expect(outdoor.options.length).toBeGreaterThan(0);

    // Every returned option's product must be effectively outdoor (explicit env or brightness ≥ threshold).
    const ids = [...new Set(outdoor.options.map((o) => o.productId))].map((id) => BigInt(id));
    const products = await prisma.ledProduct.findMany({ where: { id: { in: ids } } });
    const byId = new Map(products.map((p) => [p.id.toString(), p]));
    for (const o of outdoor.options) {
      const p = byId.get(o.productId)!;
      const effOutdoor = p.environment === 'outdoor' || (p.environment == null && (p.brightnessNits ?? 0) >= threshold);
      expect(effOutdoor).toBe(true);
      // gobRecommended is exactly pitch < 2.5; pixelPitchMm surfaced.
      expect(typeof o.pixelPitchMm).toBe('number');
      expect(o.gobRecommended).toBe(o.pixelPitchMm < 2.5);
    }

    // The unfiltered run offers strictly more products (indoor/dim ones the outdoor filter drops).
    const all = await configure(quoteId, { desiredWidthMm: 1120, desiredHeightMm: 1920 });
    const allIds = new Set(all.options.map((o) => o.productId));
    const outdoorIds = new Set(outdoor.options.map((o) => o.productId));
    expect(outdoorIds.size).toBeLessThan(allIds.size);
    for (const id of outdoorIds) expect(allIds.has(id)).toBe(true);
  });

  it('viewingDistanceM=2 excludes every product with pixel pitch > 2mm', async () => {
    const quoteId = await newQuote();
    const res = await configure(quoteId, { desiredWidthMm: 1120, desiredHeightMm: 1920, viewingDistanceM: 2 });
    expect(res.options.length).toBeGreaterThan(0);
    for (const o of res.options) expect(o.pixelPitchMm).toBeLessThanOrEqual(2);
    // And the unfiltered run includes at least one coarser (>2mm) product that this filter removed.
    const all = await configure(quoteId, { desiredWidthMm: 1120, desiredHeightMm: 1920 });
    expect(all.options.some((o) => o.pixelPitchMm > 2)).toBe(true);
  });

  it('absent env/distance params leave behaviour unchanged (baseline still returns options)', async () => {
    const quoteId = await newQuote();
    const res = await configure(quoteId, { desiredWidthMm: 1120, desiredHeightMm: 1920 });
    expect(res.options.length).toBeGreaterThan(0);
    expect(res.toleranceBands).toEqual([5, 10, 25]);
  });

  it('an impossibly close viewing distance yields empty-with-reasons (never an error)', async () => {
    const quoteId = await newQuote();
    const res = await configure(quoteId, { desiredWidthMm: 1120, desiredHeightMm: 1920, viewingDistanceM: 0.5 });
    // 0.5m → max pitch 0.5mm; if no product is that fine, expect a clear reason rather than a throw.
    if (res.options.length === 0) expect(res.reasons.some((r) => /fine enough/.test(r))).toBe(true);
    else for (const o of res.options) expect(o.pixelPitchMm).toBeLessThanOrEqual(0.5);
  });
});
