import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { buildDescriptions, servicesDescription } from './outputs.js';
import { getQuote, screenEffectiveSells } from './service.js';

/**
 * Quote review fixes:
 *   #44 a 100%-discounted LCD prices at $0 per screen (not only in the totals) — `screenEffectiveSells`;
 *   #45 a product whose price already includes GOB is never charged GOB / protective coating on top,
 *       takes the GOB spares rate, and satisfies the fine-pitch GOB requirement;
 *   #47 the install method reaches the outputs as the Summary's "Services Description".
 * (#46, the default SeenCMP media player, is a wizard default — UI only.)
 *
 * Live-DB integration: quotes use the job-ref prefix and are deleted afterwards; the one product flag
 * this file flips (`gob_included`) is restored to its original value.
 */
const JOB_PREFIX = `TESTQRF-${process.pid}-`;
// Several screen adds + re-prices per test against the remote DB — allow well beyond the 120 s default.
const SLOW = { timeout: 600_000 };
let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

let gobProductId: bigint;
let originalGobIncluded: boolean | null = null;

const newQuote = async (tag: string): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${tag}-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return res.json().id as string;
};

type Line = { lineLabel: string; cost: string | null; sell: string | null };

beforeAll(async () => {
  app = await buildApp(loadConfig());
  token = (
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@quotezen.local', password: 'demo' } })
  ).json().token as string;

  // A fine-pitch (< 2.5mm, so GOB is required) product with complete geometry + a supply cost.
  const product = await prisma.ledProduct.findFirst({
    where: {
      minCabinetWMm: { not: null },
      minCabinetHMm: { not: null },
      pixelPitchV: { not: null },
      costPerSqmUsd: { gt: 0 },
      pixelPitchH: { lt: 2.5 },
    },
    orderBy: { id: 'asc' },
  });
  expect(product).toBeTruthy();
  gobProductId = product!.id;
  originalGobIncluded = product!.gobIncluded;
});

afterAll(async () => {
  await prisma.ledProduct
    .update({ where: { id: gobProductId }, data: { gobIncluded: originalGobIncluded } })
    .catch(() => undefined);
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('#45 GOB included in the product price', () => {
  it('charges no GOB or coating on top, uses the GOB spares rate, and clears GOB_REQUIRED', SLOW, async () => {
    const paidGob = await prisma.gobOption.findFirst({ where: { price: { gt: 0 } } });
    const paidCoating = await prisma.coatingOption.findFirst({ where: { costPerSqm: { gt: 0 } } });
    const screen = {
      ledProductId: Number(gobProductId),
      desiredWidthMm: 1500,
      desiredHeightMm: 1000,
      // Try to add BOTH a paid GOB and a paid coating — neither may be charged for a GOB-included product.
      ...(paidGob ? { gobId: Number(paidGob.id) } : {}),
      ...(paidCoating ? { coatingId: Number(paidCoating.id) } : {}),
    };

    // Baseline: the same product NOT flagged → GOB_REQUIRED fires when no GOB is chosen.
    await prisma.ledProduct.update({ where: { id: gobProductId }, data: { gobIncluded: false } });
    const qPlain = await newQuote('gob-plain');
    await app.inject({
      method: 'POST',
      url: `/quotes/${qPlain}/led-screens`,
      headers: auth(),
      payload: { ledProductId: screen.ledProductId, desiredWidthMm: 1500, desiredHeightMm: 1000 },
    });
    const plainVal = (await app.inject({ method: 'GET', url: `/quotes/${qPlain}/validate`, headers: auth() })).json();
    const plainRules = plainVal.screens.flatMap((s: { findings: Array<{ rule: string }> }) => s.findings.map((f) => f.rule));
    expect(plainRules).toContain('GOB_REQUIRED');

    // Flagged as GOB-included.
    await prisma.ledProduct.update({ where: { id: gobProductId }, data: { gobIncluded: true } });
    const q = await newQuote('gob-included');
    const res = await app.inject({ method: 'POST', url: `/quotes/${q}/led-screens`, headers: auth(), payload: screen });
    expect(res.statusCode).toBe(201);
    const lines = res.json().costBreakdown as Line[];
    const costOf = (re: RegExp) => lines.filter((l) => re.test(l.lineLabel)).reduce((a, l) => a + Number(l.cost ?? 0), 0);

    expect(costOf(/^GOB/)).toBe(0);
    expect(costOf(/^Coating/)).toBe(0);
    expect(lines.some((l) => l.lineLabel === 'GOB — included in product price')).toBe(true);
    expect(lines.some((l) => l.lineLabel === 'Coating — included (GOB in product price)')).toBe(true);

    // Spares at the GOB rate (config sparesPct, 10%), not the no-GOB 15%.
    const supply = costOf(/^LED supply|^Supply|LED panels/i);
    const spares = costOf(/^Spares$/);
    if (supply > 0) expect(spares / supply).toBeLessThan(0.14);

    const val = (await app.inject({ method: 'GET', url: `/quotes/${q}/validate`, headers: auth() })).json();
    const rules = val.screens.flatMap((s: { findings: Array<{ rule: string }> }) => s.findings.map((f) => f.rule));
    expect(rules).not.toContain('GOB_REQUIRED');
  });
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

describe('#47 install method on the quote outputs', () => {
  it('servicesDescription frames the install method (+ optional suffix)', () => {
    expect(servicesDescription(null, null)).toBeNull();
    expect(servicesDescription('Wall Mount')).toBe('Service estimate based on install (by Seen Technology): Wall Mount');
    expect(servicesDescription('Freestanding', 'with cladding (by Seen Technology)')).toBe(
      'Service estimate based on install (by Seen Technology): Freestanding with cladding (by Seen Technology)',
    );
  });

  it('each LED / LCD screen description carries its install method', SLOW, async () => {
    const method = await prisma.installMethod.findFirstOrThrow({ where: { deprecated: false } });
    const q = await newQuote('install');
    await app.inject({
      method: 'POST',
      url: `/quotes/${q}/led-screens`,
      headers: auth(),
      payload: { ledProductId: Number(gobProductId), desiredWidthMm: 1500, desiredHeightMm: 1000, installMethodId: Number(method.id) },
    });
    const display = await prisma.displayCatalog.findFirstOrThrow({ where: { totalCost: { gt: 0 }, deprecated: false } });
    await app.inject({
      method: 'POST',
      url: `/quotes/${q}/lcd-screens`,
      headers: auth(),
      payload: { installMethodId: Number(method.id), items: [{ itemType: 'display', displayId: Number(display.id), qty: 1 }] },
    });
    const described = buildDescriptions(await getQuote(BigInt(q)));
    expect(described).toHaveLength(2);
    for (const d of described) expect(d.servicesDescription).toContain(method.name);
  });
});
