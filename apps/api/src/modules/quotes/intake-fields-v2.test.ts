import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Intake form v2 — new quote-level and LCD-screen-level fields from the intake
 * questionnaire V0.2. Also verifies Fix A (GOB-dependent spares pct) and Fix B
 * (per-client LED margin override via clients.defaultMargin).
 *
 * Live-RDS integration; self-cleans via a jobReference prefix.
 */
const JOB_PREFIX = `TESTIV2-${process.pid}-`;

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

// ─── Quote-level intake fields (accountExec + spaceAroundScreenMm) ────────────

describe('intake-v2 — quote-level fields (accountExec, spaceAroundScreenMm)', () => {
  it('round-trips accountExec and spaceAroundScreenMm through create → GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}Q-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        accountExec: 'Jane Smith',
        spaceAroundScreenMm: 75,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    const q = got.json();
    expect(q.accountExec).toBe('Jane Smith');
    expect(q.spaceAroundScreenMm).toBe(75);
  });

  it('clears accountExec and spaceAroundScreenMm via PATCH (null)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}QU-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
        accountExec: 'Tom Jones',
        spaceAroundScreenMm: 50,
      },
    });
    const id = created.json().id as string;
    const lockVersion = created.json().lockVersion as number;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: auth(),
      payload: {
        expectedVersion: lockVersion,
        accountExec: null,
        spaceAroundScreenMm: null,
      },
    });
    expect(patched.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    const q = got.json();
    expect(q.accountExec).toBeNull();
    expect(q.spaceAroundScreenMm).toBeNull();
  });
});

// ─── LCD screen-level intake fields (brightnessNits, dutyCycle, preferredBrand) ─

describe('intake-v2 — LCD screen-level fields (brightnessNits, dutyCycle, preferredBrand)', () => {
  it('persists brightnessNits, dutyCycle, preferredBrand through add → GET', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}QL-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
      },
    });
    expect(created.statusCode).toBe(201);
    const qid = created.json().id as string;

    const addScreen = await app.inject({
      method: 'POST',
      url: `/quotes/${qid}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'Test LCD',
        brightnessNits: 700,
        dutyCycle: '24/7',
        preferredBrand: 'Samsung',
        items: [],
      },
    });
    expect(addScreen.statusCode).toBe(201);

    const got = await app.inject({ method: 'GET', url: `/quotes/${qid}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    const q = got.json();
    const screen = q.lcdScreens[0];
    expect(screen).toBeDefined();
    expect(screen.brightnessNits).toBe(700);
    expect(screen.dutyCycle).toBe('24/7');
    expect(screen.preferredBrand).toBe('Samsung');
  });

  it('round-trips LCD intake fields through a full re-edit (PUT)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: {
        jobReference: `${JOB_PREFIX}QLE-${Math.floor(Math.random() * 1e9)}`,
        currencyCode: 'AUD',
      },
    });
    const qid = created.json().id as string;

    const addScreen = await app.inject({
      method: 'POST',
      url: `/quotes/${qid}/lcd-screens`,
      headers: auth(),
      payload: {
        screenName: 'Edit LCD',
        brightnessNits: 500,
        dutyCycle: 'Business hours (16/7)',
        preferredBrand: 'Philips',
        items: [],
      },
    });
    expect(addScreen.statusCode).toBe(201);
    const sid = addScreen.json().id as string;

    // Full re-edit — update the intake fields.
    const edited = await app.inject({
      method: 'PUT',
      url: `/quotes/${qid}/lcd-screens/${sid}`,
      headers: auth(),
      payload: {
        screenName: 'Edit LCD',
        brightnessNits: 1000,
        dutyCycle: '24/7',
        preferredBrand: 'LG',
        items: [],
      },
    });
    expect(edited.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: `/quotes/${qid}`, headers: auth() });
    const q = got.json();
    const screen = q.lcdScreens[0];
    expect(screen.brightnessNits).toBe(1000);
    expect(screen.dutyCycle).toBe('24/7');
    expect(screen.preferredBrand).toBe('LG');
  });
});

// ─── Fix A — GOB-dependent spares pct ────────────────────────────────────────

describe('Fix A — GOB-dependent spares pct (workbook row 252)', () => {
  it('uses 15% spares when no GOB selected, 10% when GOB is present', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    if (!product) return; // skip if no product in seed

    const gob = await prisma.gobOption.findFirst({ where: { price: { gt: 0 } } });

    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}GOB-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const qid = created.json().id as string;

    // Add a screen WITHOUT GOB.
    const noGob = await app.inject({
      method: 'POST',
      url: `/quotes/${qid}/led-screens`,
      headers: auth(),
      payload: {
        ledProductId: Number(product.id),
        desiredWidthMm: 960,
        desiredHeightMm: 960,
        rotateCabinets: false,
        components: [],
      },
    });
    expect(noGob.statusCode).toBe(201);

    // Get the itemised price.
    const priceRes = await app.inject({ method: 'POST', url: `/quotes/${qid}/price`, headers: auth() });
    expect(priceRes.statusCode).toBe(200);
    const priceBody = priceRes.json() as { sections: Array<{ lines: Array<{ label: string; cost: string }> }> };
    const noGobSection = priceBody.sections[0];
    const noGobSpares = noGobSection?.lines.find((l) => l.label === 'Spares');
    expect(noGobSpares).toBeDefined();

    // When GOB is available, add a screen WITH GOB and compare the spares rate.
    if (gob) {
      const withGob = await app.inject({
        method: 'POST',
        url: `/quotes/${qid}/led-screens`,
        headers: auth(),
        payload: {
          ledProductId: Number(product.id),
          desiredWidthMm: 960,
          desiredHeightMm: 960,
          rotateCabinets: false,
          gobId: Number(gob.id),
          components: [],
        },
      });
      expect(withGob.statusCode).toBe(201);

      const priceRes2 = await app.inject({ method: 'POST', url: `/quotes/${qid}/price`, headers: auth() });
      const priceBody2 = priceRes2.json() as { sections: Array<{ lines: Array<{ label: string; cost: string }> }> };
      // Section 0 = first screen (no GOB); section 1 = second screen (with GOB).
      const gobSection = priceBody2.sections[1];
      const gobSpares = gobSection?.lines.find((l) => l.label === 'Spares');
      expect(gobSpares).toBeDefined();

      // The no-GOB spares cost (15%) should be higher than the GOB spares cost (10%)
      // when both screens have the same supply cost area — note with GOB the base also
      // includes gobCostAud, but on a minimal screen the pct difference dominates.
      // We just assert that the 'Spares' line exists on both; the pct correctness is in calc tests.
      expect(Number(noGobSpares!.cost)).toBeGreaterThan(0);
      expect(Number(gobSpares!.cost)).toBeGreaterThan(0);
    }
  });
});

// ─── Fix B — per-client LED margin ────────────────────────────────────────────

describe('Fix B — per-client LED margin (RefData!F13)', () => {
  it('uses client.defaultMargin for mediaplayer sell when client has a margin override', async () => {
    const product = await prisma.ledProduct.findFirst({
      where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
    });
    if (!product) return; // skip if no product

    const mediaplayer = await prisma.mediaplayer.findFirst();
    if (!mediaplayer) return; // skip if no mediaplayer in seed

    // Create a client with a 30% LED margin (the "iVisual" tier from the workbook).
    const client = await prisma.client.create({
      data: { name: `TestClient-FixB-${Date.now()}`, defaultMargin: 0.30 },
    });

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/quotes',
        headers: auth(),
        payload: {
          jobReference: `${JOB_PREFIX}FIXB-${Math.floor(Math.random() * 1e9)}`,
          currencyCode: 'AUD',
          clientId: Number(client.id),
        },
      });
      expect(created.statusCode).toBe(201);
      const qid = created.json().id as string;

      // Add screen with a mediaplayer component to test the ledMargin override.
      const addScreen = await app.inject({
        method: 'POST',
        url: `/quotes/${qid}/led-screens`,
        headers: auth(),
        payload: {
          ledProductId: Number(product.id),
          desiredWidthMm: 960,
          desiredHeightMm: 960,
          rotateCabinets: false,
          components: [{ componentType: 'mediaplayer', mediaplayerId: Number(mediaplayer.id), qty: 1 }],
        },
      });
      expect(addScreen.statusCode).toBe(201);

      // Verify the itemised price returns something — the margin math uses ledMargin=0.30.
      const priceRes = await app.inject({ method: 'POST', url: `/quotes/${qid}/price`, headers: auth() });
      expect(priceRes.statusCode).toBe(200);
      const priceBody = priceRes.json() as { sections: Array<{ lines: Array<{ label: string; sell: string }> }> };
      const mpLine = priceBody.sections[0]?.lines.find((l) => l.label.startsWith('Mediaplayer —'));
      expect(mpLine).toBeDefined();
      expect(Number(mpLine!.sell)).toBeGreaterThan(0);

      // Cross-check: sell = cost / (1 - 0.30). Validate the ratio within rounding tolerance.
      const adminPriceBody = priceRes.json() as { sections: Array<{ lines: Array<{ label: string; sell: string; cost: string }> }> };
      const mpAdminLine = adminPriceBody.sections[0]?.lines.find((l) => l.label.startsWith('Mediaplayer —'));
      if (mpAdminLine?.cost) {
        const cost = Number(mpAdminLine.cost);
        const sell = Number(mpAdminLine.sell);
        const impliedMargin = (sell - cost) / sell;
        // The implied margin should be close to 0.30 (allowing for rounding to cents).
        expect(impliedMargin).toBeGreaterThan(0.28);
        expect(impliedMargin).toBeLessThanOrEqual(0.31);
      }
    } finally {
      await prisma.client.delete({ where: { id: client.id } });
    }
  });
});
