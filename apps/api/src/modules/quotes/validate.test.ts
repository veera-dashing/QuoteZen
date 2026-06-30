import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Integration tests for the conflict/validation engine (P1-15). Self-cleaning: quotes use a
 * unique job-reference prefix and are deleted afterwards.
 */
const JOB_PREFIX = `TESTVAL-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const jobRef = () => `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

const login = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};

// A fine-pitch product (< 2.5mm) without GOB raises a GOB_REQUIRED *error*; a coarse-pitch one is clean.
let finePitchProductId: string;
let coarsePitchProductId: string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
  salesToken = await login('sales@quotezen.local');

  const fine = await prisma.ledProduct.findFirst({
    where: { pixelPitchH: { lt: 2.5, gt: 0 }, minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchV: { not: null } },
  });
  const coarse = await prisma.ledProduct.findFirst({
    where: { pixelPitchH: { gte: 2.5 }, minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchV: { not: null } },
  });
  if (!fine || !coarse) throw new Error('Expected both a fine-pitch and coarse-pitch LED product in the catalogue');
  finePitchProductId = fine.id.toString();
  coarsePitchProductId = coarse.id.toString();
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

/** Create a sales-owned quote (so sales can act on it) and add one LED screen for the given product. */
const seedQuoteWithScreen = async (productId: string) => {
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
    url: `/quotes/${id}/led-screens`,
    headers: bearer(salesToken),
    payload: { ledProductId: Number(productId), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  expect(screen.statusCode).toBe(201);
  return id;
};

describe('validation engine (P1-15)', () => {
  it('reports a GOB error for a fine-pitch screen and a clean result for coarse pitch', async () => {
    const errId = await seedQuoteWithScreen(finePitchProductId);
    const errRes = await app.inject({ method: 'GET', url: `/quotes/${errId}/validate`, headers: bearer(salesToken) });
    expect(errRes.statusCode).toBe(200);
    const errBody = errRes.json() as {
      canFinalise: boolean;
      counts: { error: number };
      screens: Array<{ findings: Array<{ rule: string; severity: string }> }>;
    };
    expect(errBody.canFinalise).toBe(false);
    expect(errBody.counts.error).toBeGreaterThanOrEqual(1);
    expect(errBody.screens.flatMap((s) => s.findings).some((f) => f.rule === 'GOB_REQUIRED' && f.severity === 'error')).toBe(true);

    const cleanId = await seedQuoteWithScreen(coarsePitchProductId);
    const cleanRes = await app.inject({ method: 'GET', url: `/quotes/${cleanId}/validate`, headers: bearer(salesToken) });
    expect(cleanRes.statusCode).toBe(200);
    const cleanBody = cleanRes.json() as { canFinalise: boolean; counts: { error: number } };
    expect(cleanBody.canFinalise).toBe(true);
    expect(cleanBody.counts.error).toBe(0);
  });

  it('blocks non-admin finalisation on an error, but admin can override (audited)', async () => {
    const id = await seedQuoteWithScreen(finePitchProductId);

    // Sales cannot approve a quote with an error-severity conflict → 409.
    const blocked = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/status`,
      headers: bearer(salesToken),
      payload: { status: 'approved' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('conflict');

    // Admin can override; the override is recorded in the audit trail.
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

  it('allows non-admin finalisation when the quote is clean', async () => {
    const id = await seedQuoteWithScreen(coarsePitchProductId);
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
