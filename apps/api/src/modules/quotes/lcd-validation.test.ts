import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Integration tests for the LCD conflict/validation engine (X1). LCD findings flow through the SAME
 * `validateQuote` aggregate + `changeStatus` guardrail as LED. Self-cleaning: quotes use a unique
 * job-reference prefix and are deleted afterwards.
 */
const JOB_PREFIX = `TESTLCDVAL-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;
let displayId: string;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
  salesToken = await login('sales@quotezen.local');

  const display = await prisma.displayCatalog.findFirst({ where: { deprecated: false } });
  if (!display) throw new Error('Expected at least one display in the catalogue');
  displayId = display.id.toString();
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

/** Create a sales-owned quote and add one LCD screen with the given items. */
const seedQuoteWithLcd = async (items: unknown[], orientation?: 'P' | 'L') => {
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
    payload: { orientation, items },
  });
  expect(screen.statusCode).toBe(201);
  return id;
};

describe('LCD validation engine (X1)', () => {
  it('reports an error when an LCD screen has items but no display panel', async () => {
    const id = await seedQuoteWithLcd([{ itemType: 'bracket', qty: 1, unitCost: 50 }], 'L');
    const res = await app.inject({ method: 'GET', url: `/quotes/${id}/validate`, headers: bearer(salesToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      canFinalise: boolean;
      counts: { error: number };
      screens: Array<{ findings: Array<{ rule: string; severity: string }> }>;
    };
    expect(body.canFinalise).toBe(false);
    expect(body.counts.error).toBeGreaterThanOrEqual(1);
    expect(
      body.screens.flatMap((s) => s.findings).some((f) => f.rule === 'LCD_DISPLAY_REQUIRED' && f.severity === 'error'),
    ).toBe(true);
  });

  it('blocks non-admin finalisation on an LCD error, but admin can override (audited)', async () => {
    const id = await seedQuoteWithLcd([{ itemType: 'bracket', qty: 1, unitCost: 50 }], 'L');

    const blocked = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/status`,
      headers: bearer(salesToken),
      payload: { status: 'approved' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('conflict');

    const override = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/status`,
      headers: bearer(adminToken),
      payload: { status: 'approved' },
    });
    expect(override.statusCode).toBe(200);
    expect(override.json().status).toBe('approved');

    const audit = await app.inject({ method: 'GET', url: `/quotes/${id}/audit`, headers: bearer(adminToken) });
    const fields = (audit.json() as Array<{ fieldName: string | null }>).map((a) => a.fieldName);
    expect(fields).toContain('validation_guardrail');
  });

  it('validates cleanly for an LCD screen with a display, mediaplayer, bracket and orientation', async () => {
    const id = await seedQuoteWithLcd(
      [
        { itemType: 'display', displayId: Number(displayId), qty: 1 },
        { itemType: 'mediaplayer', description: 'BrightSign XT244', qty: 1, unitCost: 400 },
        { itemType: 'bracket', description: 'Tilt mount', qty: 1, unitCost: 50 },
      ],
      'L',
    );
    const res = await app.inject({ method: 'GET', url: `/quotes/${id}/validate`, headers: bearer(salesToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { canFinalise: boolean; counts: { error: number } };
    expect(body.canFinalise).toBe(true);
    expect(body.counts.error).toBe(0);

    const approved = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/status`,
      headers: bearer(salesToken),
      payload: { status: 'approved' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');
  });
});
