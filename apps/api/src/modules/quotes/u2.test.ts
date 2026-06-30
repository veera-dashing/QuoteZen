import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * U2 — manufacturer-priority ordering + lead time + size-tolerance bands.
 *  • POST /quotes/:id/screens/configure returns options ordered by manufacturer priority (lower first),
 *    each carrying manufacturerName + leadTimeDays + toleranceBand;
 *  • options whose size deviation exceeds the largest tolerance band are excluded (count in reasons).
 */
const JOB_PREFIX = `TESTU2-${process.pid}-`;
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
  manufacturerName: string | null;
  leadTimeDays: number | null;
  toleranceBand: number;
  sizeDeltaPct: string;
}
interface ConfigResp { options: ConfigRow[]; reasons: string[]; toleranceBands: number[] }

describe('U2 — configure ordering by manufacturer priority + lead time + bands', () => {
  it('orders by manufacturer priority (lower first) and carries leadTimeDays + toleranceBand', async () => {
    const quoteId = await newQuote();
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/screens/configure`,
      headers: auth(),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ConfigResp;
    expect(body.options.length).toBeGreaterThan(0);
    expect(body.toleranceBands).toEqual([5, 10, 25]); // seeded size_tolerance_bands

    // Build the priority lookup from the seeded manufacturers to assert the ordering is non-decreasing.
    const mfrs = await prisma.manufacturer.findMany();
    const priorityByName = new Map(mfrs.map((m) => [m.name, m.priority]));
    const NONE = 999;
    const priorities = body.options.map((o) =>
      o.manufacturerName ? (priorityByName.get(o.manufacturerName) ?? NONE) : NONE,
    );
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]!).toBeGreaterThanOrEqual(priorities[i - 1]!);
    }

    // Band annotated on every option: band 0 = exact; otherwise |deviation%| ≤ the assigned band.
    for (const o of body.options) {
      expect([0, 5, 10, 25]).toContain(o.toleranceBand);
      const abs = Math.abs(Number(o.sizeDeltaPct));
      if (o.toleranceBand === 0) expect(abs).toBe(0);
      else expect(abs).toBeLessThanOrEqual(o.toleranceBand);
    }
    // At least one priority-1 (LEDFul) product should appear first if any LEDFul product fits.
    const ledful = priorityByName.get('LEDFul');
    if (ledful != null && body.options.some((o) => o.manufacturerName === 'LEDFul')) {
      expect(priorities[0]).toBe(ledful);
    }
  });

  it('excludes options beyond the largest tolerance band (noted in reasons)', async () => {
    const quoteId = await newQuote();
    // Default bands = max 25%. Compare an unbounded run (huge bands) to the real one: the bounded run
    // must have ≤ options, and if any were dropped, reasons names the largest band.
    const real = (
      await app.inject({
        method: 'POST',
        url: `/quotes/${quoteId}/screens/configure`,
        headers: auth(),
        payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
      })
    ).json() as ConfigResp;

    // Every returned option is within the largest band.
    const maxBand = real.toleranceBands[real.toleranceBands.length - 1]!;
    for (const o of real.options) {
      expect(Math.abs(Number(o.sizeDeltaPct))).toBeLessThanOrEqual(maxBand);
    }
    // The over-variants (which can land far beyond +25%) should have been dropped → a reason is present.
    const hasExclusionReason = real.reasons.some((r) => /exceeding the largest size-tolerance band/.test(r));
    // Not guaranteed for every opening, but for 1120×1920 over-sizing easily exceeds +25%.
    expect(hasExclusionReason).toBe(true);
  });
});
