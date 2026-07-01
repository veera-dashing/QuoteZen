import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * LCD (LCD 1) tab automations:
 *  - FEATURE 2 (tab F23 = SUM(F9:F11)): a "Media Player Configuration" install line's qty auto-sets to
 *    the number of mediaplayers on the screen.
 *  - FEATURE 3 (tab row 30): a screen in a location with hourly_uplift>0 gets a "Location travel uplift"
 *    line = ROUND(uplift × totalInstallHours); a 0-uplift location (Melbourne) gets none; re-editing
 *    (PUT) regenerates it without duplication.
 *
 * Live-RDS integration (self-cleans via a jobReference prefix).
 */
const JOB_PREFIX = `TESTLCDAUTO-${process.pid}-`;

let app: FastifyInstance;
let token: string;
let serviceMarkup: number;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;
  serviceMarkup = Number(
    (await prisma.setting.findUnique({ where: { key: 'service_markup' } }))?.value ?? 1.65,
  );
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

interface LcdScreenJson {
  id: string;
  items: Array<{ itemType: string; description: string | null; qty: string; unitCost: string; unitSell: string }>;
  priceTotal: string;
}

const round10 = (n: number) => Math.round(n / 10) * 10;

const newQuote = async (tag: string, locationId?: bigint): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: {
      jobReference: `${JOB_PREFIX}${tag}-${Math.floor(Math.random() * 1e9)}`,
      currencyCode: 'AUD',
      ...(locationId ? { locationId: Number(locationId) } : {}),
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
};

describe('LCD tab automations', () => {
  it('(a) auto-sets a "Media Player Configuration" install line qty to the mediaplayer count (F23)', async () => {
    const quoteId = await newQuote('mediaconf');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD media conf',
        orientation: 'L',
        items: [
          { itemType: 'mediaplayer', description: 'SeenCMP MP', qty: 3, unitCost: 100 },
          // qty deliberately 1 — the server overrides it to the mediaplayer count (3).
          { itemType: 'install', description: 'Media Player Configuration', qty: 1, unitCost: 40 },
        ],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;
    const config = screen.items.find((i) => /media\s*player configuration/i.test(i.description ?? ''))!;
    expect(config).toBeTruthy();
    expect(Number(config.qty)).toBe(3);
  });

  it('(a2) media-config qty is 0 when the screen has no mediaplayers', async () => {
    const quoteId = await newQuote('mediaconf0');
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD no mp',
        orientation: 'L',
        items: [{ itemType: 'install', description: 'Media Player Configuration', qty: 5, unitCost: 40 }],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;
    const config = screen.items.find((i) => /media\s*player configuration/i.test(i.description ?? ''))!;
    expect(Number(config.qty)).toBe(0);
  });

  it('(b) a location with hourly_uplift>0 adds a Location travel uplift line = ROUND(uplift × hours); PUT does not duplicate', async () => {
    const upliftLoc = await prisma.location.findFirst({ where: { hourlyUplift: { gt: 0 } } });
    expect(upliftLoc).toBeTruthy();
    const uplift = Number(upliftLoc!.hourlyUplift);

    const quoteId = await newQuote('uplift', upliftLoc!.id);
    // One manual install line ($190 cost → 190/95 = 2 install hours). No site-attendance.
    const items = [{ itemType: 'install', description: 'On-site installation', qty: 1, unitCost: 190 }];
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: { screenName: 'LCD uplift', orientation: 'L', items },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;

    const locLines = screen.items.filter((i) => (i.description ?? '').startsWith('Location travel uplift'));
    expect(locLines.length).toBe(1);
    const totalInstallHours = 190 / 95; // = 2
    const expectedCost = Math.round(uplift * totalInstallHours);
    expect(Number(locLines[0]!.unitCost)).toBe(expectedCost);
    // Sell = cost × service markup, money-rounded to 2dp (faithful to the tab's D=C×1.65, e.g. 82.5).
    expect(Number(locLines[0]!.unitSell)).toBe(Math.round(expectedCost * serviceMarkup * 100) / 100);

    // Re-edit (PUT) with the SAME editable items — the location line must be regenerated exactly once
    // (the server strips the prior auto line before re-pricing), never duplicated.
    const put = await app.inject({
      method: 'PUT',
      url: `/quotes/${quoteId}/lcd-screens/${screen.id}`,
      headers: auth(),
      payload: { screenName: 'LCD uplift', orientation: 'L', items },
    });
    expect(put.statusCode).toBe(200);
    const updated = put.json() as LcdScreenJson;
    const locLinesAfter = updated.items.filter((i) => (i.description ?? '').startsWith('Location travel uplift'));
    expect(locLinesAfter.length).toBe(1);
    expect(Number(locLinesAfter[0]!.unitCost)).toBe(expectedCost);
  });

  it('(c) a Melbourne / 0-uplift location adds NO location line', async () => {
    const melbourne = await prisma.location.findFirst({ where: { name: { startsWith: 'Melbourne' } } });
    expect(melbourne).toBeTruthy();
    expect(Number(melbourne!.hourlyUplift)).toBe(0);

    const quoteId = await newQuote('melb', melbourne!.id);
    const lcd = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'LCD melb',
        orientation: 'L',
        items: [{ itemType: 'install', description: 'On-site installation', qty: 1, unitCost: 190 }],
      },
    });
    expect(lcd.statusCode).toBe(201);
    const screen = lcd.json() as LcdScreenJson;
    const locLines = screen.items.filter((i) => (i.description ?? '').startsWith('Location travel uplift'));
    expect(locLines.length).toBe(0);
    // priceTotal is the plain fixed-margin total of cost (190) — no uplift folded in.
    expect(Number(screen.priceTotal)).toBe(round10(190 / (1 - 0.3)));
  });
});
