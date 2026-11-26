import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { getQuote, screenEffectiveSells } from './service.js';

/**
 * Quote review fixes:
 *   #44 a 100%-discounted LCD prices at $0 per screen (not only in the totals) — `screenEffectiveSells`,
 *       used by the PDF and the wizard's screen rows.
 *
 * Live-DB integration: quotes use the job-ref prefix and are deleted afterwards.
 */
const JOB_PREFIX = `TESTQRF-${process.pid}-`;
// Several screen adds + re-prices per test against the remote DB — allow well beyond the 120 s default.
const SLOW = { timeout: 600_000 };
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

const newQuote = async (tag: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${tag}-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return res.json().id as string;
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  token = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@quotezen.local', password: 'demo' } })
  ).json().token as string;
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('#44 a fully discounted LCD is $0 per screen, not only in the totals', () => {
  it('screenEffectiveSells reflects per-line discounts (PDF + screen row use it)', SLOW, async () => {
    const display = await prisma.displayCatalog.findFirst({ where: { totalCost: { gt: 0 }, deprecated: false } });
    expect(display).toBeTruthy();
    const q = await newQuote('lcd-zero');
    const add = await app.inject({
      method: 'POST',
      url: `/quotes/${q}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'Zero me',
        items: [
          { itemType: 'display', displayId: Number(display!.id), qty: 1 },
          { itemType: 'install', description: 'Installation, Per hour', qty: 2, unitCost: 95 },
        ],
      },
    });
    expect(add.statusCode).toBe(201);
    const screen = add.json() as { id: string; priceTotal: string; items: Array<{ id: string }> };
    expect(Number(screen.priceTotal)).toBeGreaterThan(0);

    const before = screenEffectiveSells(await getQuote(BigInt(q)), new Map());
    expect(Number(before.get(`lcd:${screen.id}`))).toBe(Number(screen.priceTotal));

    for (const item of screen.items) {
      const r = await app.inject({
        method: 'PATCH',
        url: `/quotes/${q}/lcd-items/${item.id}/discount`,
        headers: auth(),
        payload: { discountPct: 1 },
      });
      expect(r.statusCode).toBe(200);
    }
    const after = screenEffectiveSells(await getQuote(BigInt(q)), new Map());
    expect(Number(after.get(`lcd:${screen.id}`))).toBe(0);
    // The stored pre-discount price is unchanged (shown struck-through in the wizard).
    const stored = await prisma.quoteLcdScreen.findUniqueOrThrow({ where: { id: BigInt(screen.id) } });
    expect(Number(stored.priceTotal)).toBe(Number(screen.priceTotal));

    const pdf = await app.inject({ method: 'GET', url: `/quotes/${q}/export.pdf`, headers: auth() });
    expect(pdf.statusCode).toBe(200);
  });
});
