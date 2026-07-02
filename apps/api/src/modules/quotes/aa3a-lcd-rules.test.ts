import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA3a — LCD selection/constraint rules. All findings flow through the SAME `validateLcdScreen` /
 * `validate.ts` aggregate exposed at `GET /quotes/:id/validate`. Rules are warning-severity (advisory),
 * so they never block finalisation. Self-cleaning: quotes use a unique job-reference prefix + we restore
 * any display rows we mutate for the depth/android checks.
 */
const JOB_PREFIX = `TESTAA3A-${process.pid}-`;
let app: FastifyInstance;
let salesToken: string;
/** A display row the AA3a rules can key off (depth/android). Restored on teardown. */
let ruleDisplayId: string;
let ruleDisplayOrig: { brand: string | null; builtInAndroid: boolean | null; depthMm: number | null } | null = null;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

interface ValidateResp {
  canFinalise: boolean;
  counts: { error: number; warning: number };
  screens: Array<{ findings: Array<{ rule: string; severity: string }> }>;
}
const validate = async (id: string): Promise<ValidateResp> => {
  const res = await app.inject({ method: 'GET', url: `/quotes/${id}/validate`, headers: bearer(salesToken) });
  expect(res.statusCode).toBe(200);
  return res.json() as ValidateResp;
};
const rules = (v: ValidateResp): string[] => v.screens.flatMap((s) => s.findings).map((f) => f.rule);

/** Create a sales-owned quote and add one LCD screen with the given payload. */
const seedQuoteWithLcd = async (payload: Record<string, unknown>) => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: bearer(salesToken),
    payload: { jobReference: jobRef(), currencyCode: 'AUD', resellerMarkup: 0 },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const screen = await app.inject({
    method: 'POST',
    url: `/quotes/${id}/lcd-screens`,
    headers: bearer(salesToken),
    payload,
  });
  expect(screen.statusCode).toBe(201);
  return id;
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  salesToken = await login('sales@quotezen.local');

  // Pick a real display and pin depth/android/brand so the depth + android rules are deterministic.
  const display = await prisma.displayCatalog.findFirst({ where: { deprecated: false }, orderBy: { id: 'asc' } });
  if (!display) throw new Error('Expected at least one display in the catalogue');
  ruleDisplayId = display.id.toString();
  ruleDisplayOrig = { brand: display.brand, builtInAndroid: display.builtInAndroid, depthMm: display.depthMm };
  await prisma.displayCatalog.update({
    where: { id: display.id },
    data: { brand: 'Samsung', builtInAndroid: false, depthMm: 120 },
  });
});

afterAll(async () => {
  if (ruleDisplayOrig) {
    await prisma.displayCatalog.update({ where: { id: BigInt(ruleDisplayId) }, data: ruleDisplayOrig });
  }
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('AA3a — LCD selection/constraint rules', () => {
  it('LCD_DEPTH_EXCEEDED when the chosen display is deeper than the site maximum', async () => {
    const id = await seedQuoteWithLcd({
      orientation: 'L',
      maxDepthMm: 90, // display depthMm = 120 (> 90)
      items: [{ itemType: 'display', displayId: Number(ruleDisplayId), qty: 1 }],
    });
    const v = await validate(id);
    expect(rules(v)).toContain('LCD_DEPTH_EXCEEDED');
    // Advisory only — a warning never blocks finalisation.
    expect(v.canFinalise).toBe(true);
  });

  it('no LCD_DEPTH_EXCEEDED when the display fits within the site maximum', async () => {
    const id = await seedQuoteWithLcd({
      orientation: 'L',
      maxDepthMm: 200, // display depthMm = 120 (< 200)
      items: [{ itemType: 'display', displayId: Number(ruleDisplayId), qty: 1 }],
    });
    const v = await validate(id);
    expect(rules(v)).not.toContain('LCD_DEPTH_EXCEEDED');
  });

  it('LCD_ANDROID_REQUIRED when a non-Android display is chosen for an Android site', async () => {
    const id = await seedQuoteWithLcd({
      orientation: 'L',
      requiresAndroid: true,
      // The display is builtInAndroid=false and its model gives no android/built-in hint.
      items: [{ itemType: 'display', displayId: Number(ruleDisplayId), qty: 1, description: 'Generic panel' }],
    });
    const v = await validate(id);
    expect(rules(v)).toContain('LCD_ANDROID_REQUIRED');
    expect(v.canFinalise).toBe(true);
  });

  it('LCD_PC_DEPENDENCY when the site needs a PC', async () => {
    const id = await seedQuoteWithLcd({
      orientation: 'L',
      needsPc: true,
      items: [{ itemType: 'display', displayId: Number(ruleDisplayId), qty: 1 }],
    });
    const v = await validate(id);
    expect(rules(v)).toContain('LCD_PC_DEPENDENCY');
    expect(v.canFinalise).toBe(true);
  });

  it('LCD_BRACKET_SUBRANGE when a bracket does not support portrait for a portrait screen', async () => {
    // Ensure a bracket-category display row with a size range + portraitCapable=false exists (seeded, but
    // make the test self-contained by picking/pinning one).
    let bracket = await prisma.displayCatalog.findFirst({
      where: { category: { contains: 'racket', mode: 'insensitive' }, deprecated: false },
      orderBy: { id: 'asc' },
    });
    if (!bracket) {
      // No bracket category in the catalogue — skip the assertion gracefully (never a false failure).
      return;
    }
    const origBracket = { minSizeIn: bracket.minSizeIn, maxSizeIn: bracket.maxSizeIn, portraitCapable: bracket.portraitCapable };
    await prisma.displayCatalog.update({
      where: { id: bracket.id },
      data: { minSizeIn: 32, maxSizeIn: 65, portraitCapable: false },
    });
    try {
      const id = await seedQuoteWithLcd({
        orientation: 'P', // portrait, but bracket portraitCapable=false
        items: [
          { itemType: 'display', displayId: Number(ruleDisplayId), qty: 1 },
          { itemType: 'bracket', displayId: Number(bracket.id.toString()), qty: 1 },
        ],
      });
      const v = await validate(id);
      expect(rules(v)).toContain('LCD_BRACKET_SUBRANGE');
      expect(v.canFinalise).toBe(true);
    } finally {
      await prisma.displayCatalog.update({ where: { id: bracket.id }, data: origBracket });
    }
  });

  it('no AA3a findings when no requirement fields are set (never a false warning)', async () => {
    const id = await seedQuoteWithLcd({
      orientation: 'L',
      items: [{ itemType: 'display', displayId: Number(ruleDisplayId), qty: 1 }],
    });
    const v = await validate(id);
    const found = rules(v);
    for (const r of ['LCD_DEPTH_EXCEEDED', 'LCD_ANDROID_REQUIRED', 'LCD_PC_DEPENDENCY']) {
      expect(found).not.toContain(r);
    }
  });
});
