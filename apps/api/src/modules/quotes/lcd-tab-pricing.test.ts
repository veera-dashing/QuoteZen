import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * LCD pricing faithful to the source workbook's `(LCD 1)` tab.
 *
 * The tab's item breakdown shows the LIST Sell per line (col D — `display_catalog.sell` for a catalog
 * row, Cost × service markup for a manual row). The HEADLINE quoted total is NOT the sum of the line
 * sells — it is the total COST grossed at the fixed LCD margin (30%) and rounded to the nearest $10
 * (G54 = ROUND(H46/(1−I54), −1)). These two figures generally differ; the tab reconciles via its
 * per-section analysis block. This suite pins that behaviour end-to-end against the live RDS.
 */
const JOB_PREFIX = `TESTLCDTAB-${process.pid}-`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round10 = (n: number) => Math.round(n / 10) * 10;

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

interface LcdScreenJson {
  id: string;
  items: Array<{ itemType: string; displayId: string | null; qty: string; unitCost: string; unitSell: string }>;
  priceScreenMediaplayer: string;
  priceBracketShroud: string;
  priceServices: string;
  priceTotal: string;
}

const newQuote = async (tag: string): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: `${JOB_PREFIX}${tag}-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  return created.json().id as string;
};

describe('LCD (LCD 1) tab pricing — list sells per line, fixed-margin total', () => {
  it('lists the catalog list Sell per line, but quotes the fixed-margin total of cost', async () => {
    // A catalog display with a known cost AND list sell so both the line sell and the fixed-margin
    // total are assertable (and, importantly, the two differ so we can prove they do NOT reconcile).
    const lcdMargin = Number(
      (await prisma.setting.findUnique({ where: { key: 'lcd_margin' } }))?.value ?? 0.3,
    );
    const serviceMarkup = Number(
      (await prisma.setting.findUnique({ where: { key: 'service_markup' } }))?.value ?? 1.65,
    );
    const display = await prisma.displayCatalog.findFirst({
      where: { deprecated: false, totalCost: { not: null }, sell: { not: null } },
    });
    expect(display).toBeTruthy();
    const displayCost = Number(display!.totalCost);
    const displaySell = Number(display!.sell);

    const quoteId = await newQuote('tab');
    // A catalog display (qty 2) + a manual install row (cost 95, no explicit sell → cost × markup).
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD tab',
        orientation: 'L',
        items: [
          { itemType: 'display', displayId: Number(display!.id), qty: 2 },
          { itemType: 'install', description: 'Installation, Per hour', qty: 1, unitCost: 95 },
        ],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;

    // (a) Each stored line's unitSell is the LIST sell — catalog.sell for the display, cost×markup manual.
    const displayItem = screen.items.find((i) => i.itemType === 'display')!;
    expect(Number(displayItem.unitCost)).toBe(round2(displayCost));
    expect(Number(displayItem.unitSell)).toBe(round2(displaySell));
    const installItem = screen.items.find((i) => i.itemType === 'install')!;
    expect(Number(installItem.unitSell)).toBe(round2(95 * serviceMarkup));

    // (b) priceTotal = ROUND(Σ(cost×qty) / (1 − lcd_margin), −1).
    const totalCost = displayCost * 2 + 95;
    const expectTotal = round10(totalCost / (1 - lcdMargin));
    expect(Number(screen.priceTotal)).toBe(expectTotal);

    // (c) priceTotal ≠ Σ(item.unitSell × qty) — the list sells do NOT reconcile to the headline total.
    const sumLineSells = round2(
      screen.items.reduce((a, i) => a + Number(i.unitSell) * Number(i.qty), 0),
    );
    expect(sumLineSells).not.toBe(Number(screen.priceTotal));

    // Section subtotals mirror the tab's per-section fixed-margin analysis (G51/G53).
    expect(Number(screen.priceScreenMediaplayer)).toBe(round10((displayCost * 2) / (1 - lcdMargin)));
    expect(Number(screen.priceServices)).toBe(round10(95 / (1 - lcdMargin)));
    expect(Number(screen.priceBracketShroud)).toBe(0);
  });

  it('a per-line discount lowers the rolled-up screen sell proportionally by cost', async () => {
    const display = await prisma.displayCatalog.findFirst({
      where: { deprecated: false, totalCost: { not: null }, sell: { not: null } },
    });
    expect(display).toBeTruthy();
    const quoteId = await newQuote('disc');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD disc',
        orientation: 'L',
        items: [{ itemType: 'display', displayId: Number(display!.id), qty: 2 }],
      },
    });
    expect(lcd.statusCode).toBe(201);

    const priceBefore = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() });
    const before = priceBefore.json() as { sections: Array<{ type: string; total: string; lines: Array<{ id: string; sell: string | null }> }> };
    const lcdBefore = before.sections.find((s) => s.type === 'lcd')!;
    // With NO discount the section total equals the fixed-margin total (priceTotal) exactly.
    expect(Number(lcdBefore.total)).toBe(Number((lcd.json() as LcdScreenJson).priceTotal));

    const item = lcdBefore.lines.find((l) => l.sell != null && Number(l.sell) > 0)!;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${quoteId}/lcd-items/${item.id}/discount`,
      headers: auth(),
      payload: { discountPct: 0.5 },
    });
    expect(patched.statusCode).toBe(200);

    const priceAfter = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/price`, headers: auth() });
    const after = priceAfter.json() as { sections: Array<{ type: string; total: string }> };
    const lcdAfter = after.sections.find((s) => s.type === 'lcd')!;
    // The whole (only) line is discounted 50% → the rolled-up screen sell drops to 50% of priceTotal.
    expect(Number(lcdAfter.total)).toBeCloseTo(Number(lcdBefore.total) * 0.5, 0);
    expect(Number(lcdAfter.total)).toBeLessThan(Number(lcdBefore.total));
  });
});
