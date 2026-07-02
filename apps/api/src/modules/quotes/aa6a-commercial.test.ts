import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * AA6a — commercial intake + recommendation advisories (workshop Group F, no-pricing-risk parts).
 *
 * Verifies:
 *  • the 5 quote-level commercial fields round-trip through create → GET (+ clear on PATCH);
 *  • SOLUTIONS_ENGINEER_REVIEW fires via the flag AND via the screen-count threshold;
 *  • FREIGHT_MODE_RECOMMENDATION recommends air for a tight go-live date;
 *  • the tier endpoint returns the client's typicalSelectionNote.
 *
 * Live-RDS integration; self-cleans via a jobReference prefix + restores the borrowed client row.
 */
const JOB_PREFIX = `TESTAA6A-${process.pid}-`;

let app: FastifyInstance;
let token: string;
const auth = () => ({ authorization: `Bearer ${token}` });

// A fully-specified LED product with a manufacturer lead time (for the freight-mode check).
let productId: string;
let manufacturerLeadDays: number;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  token = res.json().token as string;

  const product = await prisma.ledProduct.findFirst({
    where: {
      deprecated: false,
      manufacturerId: { not: null },
      minCabinetWMm: { not: null },
      minCabinetHMm: { not: null },
      pixelPitchH: { not: null },
      pixelPitchV: { not: null },
    },
    include: { manufacturer: true },
    orderBy: { id: 'asc' },
  });
  if (!product?.manufacturer?.leadTimeDays) {
    throw new Error('Expected an LED product with a manufacturer lead time in the catalogue');
  }
  productId = product.id.toString();
  manufacturerLeadDays = product.manufacturer.leadTimeDays;
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const newQuote = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const res = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: auth(),
    payload: { jobReference: jobRef(), currencyCode: 'AUD', ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};

const addLedScreen = async (quoteId: string): Promise<void> => {
  const res = await app.inject({
    method: 'POST',
    url: `/quotes/${quoteId}/led-screens`,
    headers: auth(),
    payload: { ledProductId: Number(productId), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: false },
  });
  expect(res.statusCode).toBe(201);
};

interface Finding { rule: string; severity: string; message: string }
interface ValidateResp { anomalies: Finding[]; canFinalise: boolean }
const validate = async (quoteId: string): Promise<ValidateResp> => {
  const res = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/validate`, headers: auth() });
  expect(res.statusCode).toBe(200);
  return res.json() as ValidateResp;
};

const COMMERCIAL = {
  priceSensitivity: 'premium',
  budgetAud: 50000,
  tenureMonths: 36,
  clientMustHaves: 'Must integrate with the existing BMS and support 24/7 operation.',
  needsSolutionsEngineer: true,
} as const;

describe('AA6a — commercial intake fields', () => {
  it('round-trips the commercial fields through create → GET', async () => {
    const id = await newQuote(COMMERCIAL);
    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    const q = got.json();
    expect(q.priceSensitivity).toBe('premium');
    expect(Number(q.budgetAud)).toBe(50000);
    expect(q.tenureMonths).toBe(36);
    expect(q.clientMustHaves).toBe(COMMERCIAL.clientMustHaves);
    expect(q.needsSolutionsEngineer).toBe(true);
  });

  it('updates (PATCH) and clears a commercial field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: jobRef(), currencyCode: 'AUD', ...COMMERCIAL },
    });
    const id = created.json().id as string;
    const lockVersion = created.json().lockVersion as number;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: auth(),
      payload: { expectedVersion: lockVersion, priceSensitivity: 'budget', tenureMonths: null, needsSolutionsEngineer: false },
    });
    expect(patched.statusCode).toBe(200);

    const q = (await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: auth() })).json();
    expect(q.priceSensitivity).toBe('budget');
    expect(q.tenureMonths).toBeNull();
    expect(q.needsSolutionsEngineer).toBe(false);
    // Untouched fields stay.
    expect(Number(q.budgetAud)).toBe(50000);
    expect(q.clientMustHaves).toBe(COMMERCIAL.clientMustHaves);
  });

  it('folds client must-haves into the register assumptions', async () => {
    const id = await newQuote({ clientMustHaves: 'Weatherproof enclosure required.' });
    const reg = await app.inject({ method: 'GET', url: `/quotes/${id}/register`, headers: auth() });
    expect(reg.statusCode).toBe(200);
    const assumptions = reg.json().assumptions as string[];
    expect(assumptions.some((a) => a.includes('Weatherproof enclosure required.'))).toBe(true);
  });
});

describe('AA6a — SOLUTIONS_ENGINEER_REVIEW advisory (warning, never blocks)', () => {
  it('fires when the needsSolutionsEngineer flag is set', async () => {
    const id = await newQuote({ needsSolutionsEngineer: true });
    const v = await validate(id);
    const se = v.anomalies.find((a) => a.rule === 'SOLUTIONS_ENGINEER_REVIEW');
    expect(se).toBeDefined();
    expect(se?.severity).toBe('warning');
    // Advisory-only: it must not block finalisation.
    expect(v.canFinalise).toBe(true);
  });

  it('fires via the screen-count threshold (setting default 10)', async () => {
    const setting = await prisma.setting.findUnique({ where: { key: 'solutions_engineer_screen_threshold' } });
    const threshold = setting?.value != null ? Number(setting.value) : 10;
    const id = await newQuote();
    // Add threshold + 1 LED screens so the count exceeds the threshold.
    for (let i = 0; i < threshold + 1; i++) await addLedScreen(id);
    const v = await validate(id);
    const se = v.anomalies.find((a) => a.rule === 'SOLUTIONS_ENGINEER_REVIEW');
    expect(se).toBeDefined();
    expect(se?.message).toContain(String(threshold));
  });

  it('does NOT fire with no flag and few screens', async () => {
    const id = await newQuote();
    await addLedScreen(id);
    const v = await validate(id);
    expect(v.anomalies.find((a) => a.rule === 'SOLUTIONS_ENGINEER_REVIEW')).toBeUndefined();
  });
});

describe('AA6a — FREIGHT_MODE_RECOMMENDATION advisory', () => {
  it('recommends air for a tight go-live date', async () => {
    // A ship date only 7 days out is far tighter than lead (45d) + buffer + sea transit.
    const shipDate = new Date();
    shipDate.setDate(shipDate.getDate() + 7);
    const id = await newQuote({ requestedShippingDate: shipDate.toISOString() });
    await addLedScreen(id);
    const v = await validate(id);
    const f = v.anomalies.find((a) => a.rule === 'FREIGHT_MODE_RECOMMENDATION');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
    expect(f?.message.toLowerCase()).toContain('air freight');
    // Advisory, never blocks: no freight advisory is ever an 'error'.
    expect(v.anomalies.filter((a) => a.rule === 'FREIGHT_MODE_RECOMMENDATION' && a.severity === 'error')).toHaveLength(0);
    expect(manufacturerLeadDays).toBeGreaterThan(0); // sanity: the product carries a lead time
  });

  it('notes sea is fine for a far-out go-live date', async () => {
    const shipDate = new Date();
    shipDate.setDate(shipDate.getDate() + 365);
    const id = await newQuote({ requestedShippingDate: shipDate.toISOString() });
    await addLedScreen(id);
    const v = await validate(id);
    const f = v.anomalies.find((a) => a.rule === 'FREIGHT_MODE_RECOMMENDATION');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('info');
    expect(f?.message.toLowerCase()).toContain('sea freight');
  });

  it('does not evaluate freight mode when no shipping date is set', async () => {
    const id = await newQuote();
    await addLedScreen(id);
    const v = await validate(id);
    expect(v.anomalies.find((a) => a.rule === 'FREIGHT_MODE_RECOMMENDATION')).toBeUndefined();
  });
});

describe('AA6a — tier endpoint surfaces the client typical-selection note', () => {
  let clientId: bigint;
  let originalNote: string | null;

  beforeAll(async () => {
    // Borrow an existing client, stash + set its typicalSelectionNote, restore in afterAll.
    const client = await prisma.client.findFirst({ orderBy: { id: 'asc' } });
    if (!client) throw new Error('Expected at least one client in the DB');
    clientId = client.id;
    originalNote = client.typicalSelectionNote;
    await prisma.client.update({
      where: { id: clientId },
      data: { typicalSelectionNote: 'Usually goes with the premium ISD range.' },
    });
  });

  afterAll(async () => {
    await prisma.client.update({ where: { id: clientId }, data: { typicalSelectionNote: originalNote } });
  });

  it('returns commercialHints.typicalSelectionNote + emphasisTier on the LED tier endpoint', async () => {
    const id = await newQuote({ clientId: Number(clientId), priceSensitivity: 'premium' });
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/screens/options`,
      headers: auth(),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commercialHints: { typicalSelectionNote: string | null; priceSensitivity: string | null; emphasisTier: string | null } };
    expect(body.commercialHints.typicalSelectionNote).toBe('Usually goes with the premium ISD range.');
    expect(body.commercialHints.priceSensitivity).toBe('premium');
    expect(body.commercialHints.emphasisTier).toBe('premium');
  });

  it('returns commercialHints on the LCD tier endpoint too', async () => {
    const id = await newQuote({ clientId: Number(clientId), priceSensitivity: 'budget' });
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/lcd-options`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commercialHints: { typicalSelectionNote: string | null; emphasisTier: string | null } };
    expect(body.commercialHints.typicalSelectionNote).toBe('Usually goes with the premium ISD range.');
    expect(body.commercialHints.emphasisTier).toBe('value'); // budget → value
  });
});
