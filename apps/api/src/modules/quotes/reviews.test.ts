import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/** Two-stage Review & Approval (T1 / BR-001, FR-102–110). */
const JOB_PREFIX = `REV-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
const admin = () => ({ authorization: `Bearer ${adminToken}` });

const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json()
    .token as string;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

const newQuoteWithScreen = async () => {
  const product = await prisma.ledProduct.findFirst({
    where: { minCabinetWMm: { not: null }, pixelPitchH: { not: null }, costPerSqmUsd: { not: null } },
  });
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers: admin(),
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/quotes/${id}/led-screens`,
    headers: admin(),
    payload: { ledProductId: Number(product!.id), desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
  });
  return id;
};

describe('two-stage review & approval (T1 / BR-001)', () => {
  it('blocks issuing until BOTH technical + commercial reviews are approved for the current revision', async () => {
    const id = await newQuoteWithScreen();

    // No reviews yet → issuing is blocked, even for an admin (BR-001 is absolute).
    const noReviews = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: admin(), payload: { status: 'issued' } });
    expect(noReviews.statusCode).toBe(409);
    expect(noReviews.json().error.message).toMatch(/technical and commercial/);

    // Technical approval advances to commercial_review.
    const tech = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/reviews`,
      headers: admin(),
      payload: { stage: 'technical', decision: 'approved', comment: 'engineering OK' },
    });
    expect(tech.statusCode).toBe(201);
    expect(tech.json().status).toBe('commercial_review');

    // Still missing commercial → issue blocked, naming what's missing.
    const stillBlocked = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: admin(), payload: { status: 'issued' } });
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.json().error.message).toMatch(/commercial/);

    // Commercial approval advances to approved.
    const comm = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/reviews`,
      headers: admin(),
      payload: { stage: 'commercial', decision: 'approved', comment: 'pricing OK' },
    });
    expect(comm.statusCode).toBe(201);
    expect(comm.json().status).toBe('approved');

    // Both approved for the current revision → issuing now succeeds.
    const issued = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: admin(), payload: { status: 'issued' } });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe('issued');
  });

  it('a reject kicks the quote back and is recorded in the immutable history', async () => {
    const id = await newQuoteWithScreen();

    const rejected = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/reviews`,
      headers: admin(),
      payload: { stage: 'technical', decision: 'rejected', comment: 'controller mismatch' },
    });
    expect(rejected.statusCode).toBe(201);
    expect(rejected.json().status).toBe('in_review'); // kicked back

    // A reject does NOT satisfy the gate → issuing is still blocked.
    const blocked = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: admin(), payload: { status: 'issued' } });
    expect(blocked.statusCode).toBe(409);

    const history = await app.inject({ method: 'GET', url: `/quotes/${id}/reviews`, headers: admin() });
    expect(history.statusCode).toBe(200);
    const rows = history.json() as Array<{ stage: string; decision: string; comment: string | null; lockVersion: number }>;
    expect(rows.some((r) => r.stage === 'technical' && r.decision === 'rejected' && r.comment === 'controller mismatch')).toBe(true);
  });

  it('preserves approval history across revisions and re-arms the gate when the quote changes (FR-110)', async () => {
    const id = await newQuoteWithScreen();

    // Approve both stages for the current revision.
    await app.inject({ method: 'POST', url: `/quotes/${id}/reviews`, headers: admin(), payload: { stage: 'technical', decision: 'approved' } });
    await app.inject({ method: 'POST', url: `/quotes/${id}/reviews`, headers: admin(), payload: { stage: 'commercial', decision: 'approved' } });

    const beforeEdit = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: admin() });
    const lockBefore = beforeEdit.json().lockVersion as number;

    // Edit the quote → lockVersion bumps, so the old approvals no longer satisfy the gate.
    await app.inject({ method: 'PATCH', url: `/quotes/${id}`, headers: admin(), payload: { resellerMarkup: 0.05, expectedVersion: lockBefore } });

    const reBlocked = await app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers: admin(), payload: { status: 'issued' } });
    expect(reBlocked.statusCode).toBe(409); // approvals were for the prior revision

    // The earlier approvals are still in the history (never deleted) — they reference the old revision.
    const history = (await app.inject({ method: 'GET', url: `/quotes/${id}/reviews`, headers: admin() })).json() as Array<{ stage: string; decision: string; lockVersion: number }>;
    const approvedRows = history.filter((r) => r.decision === 'approved');
    expect(approvedRows.length).toBe(2);
    expect(approvedRows.every((r) => r.lockVersion < lockBefore + 1)).toBe(true);
  });
});
