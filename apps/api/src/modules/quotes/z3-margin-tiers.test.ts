import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Z3 — two-tier margin guardrail at finalisation + lead-time buffer.
 *
 * The finalisation gate is driven by TWO settings (not the old single `margin_floor`):
 *   • m ≥ min_gross_margin (28%)                    → OK for anyone.
 *   • walk_away_margin (22%) ≤ m < min_gross_margin → APPROVER (admin/director/manager) required.
 *   • m < walk_away_margin (22%)                    → DIRECTOR-level (admin/director only) required.
 *
 * These tests use a CLEAN coarse-pitch LED screen (no GOB error → validation guardrail passes) so the
 * margin band is the only gate. The base screen margin is measured live, then the min_gross_margin /
 * walk_away_margin settings are moved to bracket that fixed margin into each band — robust to catalog
 * price changes. Settings are restored in afterAll.
 */
const JOB_PREFIX = `Z3-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;
let managerToken: string;
let directorToken: string;
let coarseProductId: string;
/** The base (undiscounted) margin of a clean coarse-pitch screen — measured in beforeAll. */
let baseMargin: number;
/** Seeded values to restore. */
let seedMinGross = 0.28;
let seedWalkAway = 0.22;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json()
    .token as string;

const setThresholds = async (minGross: number, walkAway: number) => {
  await prisma.setting.update({ where: { key: 'min_gross_margin' }, data: { value: minGross } });
  await prisma.setting.update({ where: { key: 'walk_away_margin' }, data: { value: walkAway } });
};

/** A fresh sales-owned quote with one clean coarse-pitch LED screen. */
const newQuoteWithScreen = async (headers: Record<string, string>): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers,
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const screen = await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers,
    payload: { ledProductId: Number(coarseProductId), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  expect(screen.statusCode).toBe(201);
  return id;
};

const approve = (id: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers, payload: { status: 'approved' } });

const hasMarginGuardrailAudit = async (id: string): Promise<boolean> => {
  const audit = await app.inject({ method: 'GET', url: `/quotes/${id}/audit`, headers: bearer(adminToken) });
  return (audit.json() as Array<{ fieldName: string | null }>).some((a) => a.fieldName === 'margin_guardrail');
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
  salesToken = await login('sales@quotezen.local');
  managerToken = await login('manager@quotezen.local');
  directorToken = await login('director@quotezen.local');

  // Remember the seeded thresholds to restore afterwards.
  const min = await prisma.setting.findUnique({ where: { key: 'min_gross_margin' } });
  const walk = await prisma.setting.findUnique({ where: { key: 'walk_away_margin' } });
  if (min) seedMinGross = Number(min.value);
  if (walk) seedWalkAway = Number(walk.value);

  // A coarse-pitch product (≥2.5mm) avoids the GOB_REQUIRED validation error so the margin band is the
  // sole gate; it must carry a USD supply cost so the screen actually has a margin.
  const coarse = await prisma.ledProduct.findFirst({
    where: {
      pixelPitchH: { gte: 2.5 },
      minCabinetWMm: { not: null },
      minCabinetHMm: { not: null },
      pixelPitchV: { not: null },
      costPerSqmUsd: { not: null },
      deprecated: false,
    },
  });
  if (!coarse) throw new Error('Expected a coarse-pitch LED product with a USD supply cost in the catalogue');
  coarseProductId = coarse.id.toString();

  // Measure the base (undiscounted) screen margin so we can bracket it into each band deterministically.
  const probe = await newQuoteWithScreen(bearer(adminToken));
  const price = await app.inject({ method: 'POST', url: `/quotes/${probe}/price`, headers: bearer(adminToken) });
  baseMargin = Number((price.json() as { totals: { margin: string } }).totals.margin);
  expect(baseMargin).toBeGreaterThan(0.05); // sanity: a real margin to bracket
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await setThresholds(seedMinGross, seedWalkAway).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

describe('Z3 — thin band (walk-away ≤ margin < min-gross) → approver required', () => {
  it('blocks sales (403) but a manager OR a director can finalise (200) + audit', async () => {
    // Bracket the base margin into the THIN band: walk-away < baseMargin < min-gross.
    await setThresholds(baseMargin + 0.1, baseMargin - 0.1);

    // Sales is not an approver → blocked, message names the 28%-style min-gross threshold.
    const salesQuote = await newQuoteWithScreen(bearer(salesToken));
    const blocked = await approve(salesQuote, bearer(salesToken));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.message).toMatch(/minimum gross margin.*Manager or Director approval required/);

    // A manager may approve their own quote in this band.
    const mgrQuote = await newQuoteWithScreen(bearer(managerToken));
    const mgrOk = await approve(mgrQuote, bearer(managerToken));
    expect(mgrOk.statusCode).toBe(200);
    expect(mgrOk.json().status).toBe('approved');
    expect(await hasMarginGuardrailAudit(mgrQuote)).toBe(true);

    // A director may too.
    const dirQuote = await newQuoteWithScreen(bearer(directorToken));
    const dirOk = await approve(dirQuote, bearer(directorToken));
    expect(dirOk.statusCode).toBe(200);
    expect(await hasMarginGuardrailAudit(dirQuote)).toBe(true);
  });
});

describe('Z3 — below the walk-away floor (margin < walk-away) → director-level required', () => {
  it('blocks sales AND manager (403); a director (or admin) finalises (200) + audit', async () => {
    // Bracket the base margin BELOW the walk-away floor: baseMargin < walk-away < min-gross.
    await setThresholds(baseMargin + 0.2, baseMargin + 0.1);

    // Sales blocked.
    const salesQuote = await newQuoteWithScreen(bearer(salesToken));
    const salesBlocked = await approve(salesQuote, bearer(salesToken));
    expect(salesBlocked.statusCode).toBe(403);
    expect(salesBlocked.json().error.message).toMatch(/walk-away floor. Director approval required/);

    // Manager ALSO blocked below the walk-away floor.
    const mgrQuote = await newQuoteWithScreen(bearer(managerToken));
    const mgrBlocked = await approve(mgrQuote, bearer(managerToken));
    expect(mgrBlocked.statusCode).toBe(403);
    expect(mgrBlocked.json().error.message).toMatch(/walk-away floor. Director approval required/);

    // Director can finalise.
    const dirQuote = await newQuoteWithScreen(bearer(directorToken));
    const dirOk = await approve(dirQuote, bearer(directorToken));
    expect(dirOk.statusCode).toBe(200);
    expect(dirOk.json().status).toBe('approved');
    expect(await hasMarginGuardrailAudit(dirQuote)).toBe(true);

    // Admin can too.
    const adminQuote = await newQuoteWithScreen(bearer(adminToken));
    const adminOk = await approve(adminQuote, bearer(adminToken));
    expect(adminOk.statusCode).toBe(200);
    expect(await hasMarginGuardrailAudit(adminQuote)).toBe(true);
  });
});

describe('Z3 — at/above min-gross (margin ≥ min-gross) → no gate for anyone', () => {
  it('sales finalises without approval and no margin_guardrail audit note is written', async () => {
    // Set min-gross BELOW the base margin so the quote clears the gate entirely.
    await setThresholds(baseMargin - 0.1, baseMargin - 0.2);

    const salesQuote = await newQuoteWithScreen(bearer(salesToken));
    const ok = await approve(salesQuote, bearer(salesToken));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('approved');
    // No guardrail fired → no margin_guardrail note.
    expect(await hasMarginGuardrailAudit(salesQuote)).toBe(false);
  });
});

describe('Z3 — lead-time buffer added to configured options', () => {
  it('configure options carry manufacturer leadTimeDays + the buffer', async () => {
    const buffer = Number(
      (await prisma.setting.findUnique({ where: { key: 'lead_time_buffer_days' } }))?.value ?? 3,
    );
    expect(buffer).toBeGreaterThan(0);

    const id = await newQuoteWithScreen(bearer(salesToken));
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/screens/configure`,
      headers: bearer(salesToken),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      options: Array<{ productId: string; leadTimeDays: number | null }>;
    };
    expect(body.options.length).toBeGreaterThan(0);

    // Find an option whose product has a manufacturer lead time, and assert the quoted lead time =
    // manufacturer lead time + buffer.
    let checked = 0;
    for (const o of body.options) {
      const prod = await prisma.ledProduct.findUnique({
        where: { id: BigInt(o.productId) },
        include: { manufacturer: true },
      });
      const mfrLead = prod?.manufacturer?.leadTimeDays ?? null;
      if (mfrLead != null) {
        expect(o.leadTimeDays).toBe(mfrLead + buffer);
        checked += 1;
        if (checked >= 3) break;
      } else {
        expect(o.leadTimeDays).toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(0); // at least one option had a manufacturer lead time
  });
});
