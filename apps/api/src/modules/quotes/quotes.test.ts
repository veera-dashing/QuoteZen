import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Integration tests against the live database. They create quotes under a unique job-reference
 * prefix and delete them afterwards, so the suite is self-cleaning and safe to re-run.
 */
const JOB_PREFIX = `TEST-${process.pid}-`;
let app: FastifyInstance;
let token: string;

const authHeader = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp(loadConfig());
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@quotezen.local', password: 'demo' },
  });
  expect(res.statusCode).toBe(200);
  token = res.json().token as string;
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});

describe('auth', () => {
  it('rejects bad credentials with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@quotezen.local', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('blocks unauthenticated access to /quotes', async () => {
    const res = await app.inject({ method: 'GET', url: '/quotes' });
    expect(res.statusCode).toBe(401);
  });
});

describe('quote lifecycle', () => {
  it('creates, reads, updates, transitions, recomputes and audits a quote', async () => {
    const jobReference = `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`;

    // create
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { jobReference, currencyCode: 'AUD', resellerMarkup: 0 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json().status).toBe('draft');

    // read
    const got = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: authHeader() });
    expect(got.statusCode).toBe(200);
    expect(got.json().jobReference).toBe(jobReference);

    // update (reseller markup change)
    const patched = await app.inject({
      method: 'PATCH',
      url: `/quotes/${id}`,
      headers: authHeader(),
      payload: { resellerMarkup: 0.1 },
    });
    expect(patched.statusCode).toBe(200);
    expect(Number(patched.json().resellerMarkup)).toBe(0.1);

    // status transition
    const status = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/status`,
      headers: authHeader(),
      payload: { status: 'in_review', reason: 'ready for review' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe('in_review');

    // recompute (no children → zero totals)
    const recomputed = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/recompute`,
      headers: authHeader(),
    });
    expect(recomputed.statusCode).toBe(200);
    expect(Number(recomputed.json().grandTotal)).toBe(0);

    // audit trail: create + update + status_change + recompute
    const audit = await app.inject({
      method: 'GET',
      url: `/quotes/${id}/audit`,
      headers: authHeader(),
    });
    expect(audit.statusCode).toBe(200);
    const actions = (audit.json() as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('create');
    expect(actions).toContain('update');
    expect(actions).toContain('status_change');
  });

  it('rejects a duplicate job reference with 409', async () => {
    const jobReference = `${JOB_PREFIX}dup-${Math.floor(Math.random() * 1e9)}`;
    const payload = { jobReference, currencyCode: 'AUD' };
    const first = await app.inject({ method: 'POST', url: '/quotes', headers: authHeader(), payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/quotes', headers: authHeader(), payload });
    expect(second.statusCode).toBe(409);
  });

  it('returns 422 on invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { currencyCode: 'AUD' }, // missing jobReference
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('returns 404 for a missing quote', async () => {
    const res = await app.inject({ method: 'GET', url: '/quotes/999999999', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });

  it('exports a quote as a PDF', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { jobReference: `${JOB_PREFIX}pdf-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    const res = await app.inject({ method: 'GET', url: `/quotes/${id}/export.pdf`, headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('scopes quotes per user (sales cannot see admin-owned quotes)', async () => {
    const salesLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'sales@quotezen.local', password: 'demo' },
    });
    const salesToken = salesLogin.json().token as string;
    const salesAuth = { authorization: `Bearer ${salesToken}` };

    // admin creates a quote
    const adminQuote = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { jobReference: `${JOB_PREFIX}scope-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const adminId = adminQuote.json().id as string;

    // sales cannot read it (403)
    const forbidden = await app.inject({ method: 'GET', url: `/quotes/${adminId}`, headers: salesAuth });
    expect(forbidden.statusCode).toBe(403);

    // sales list does not include the admin quote
    const salesList = await app.inject({ method: 'GET', url: '/quotes', headers: salesAuth });
    const ids = (salesList.json() as Array<{ id: string }>).map((q) => q.id);
    expect(ids).not.toContain(adminId);
  });

  it('accepts a bodyless POST that still declares application/json (browser fetch case)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { jobReference: `${JOB_PREFIX}empty-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/recompute`,
      headers: { ...authHeader(), 'content-type': 'application/json' }, // empty body + json header
    });
    expect(res.statusCode).toBe(200);
  });

  it('serves editable, versioned proposal terms (P1-18.2)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { jobReference: `${JOB_PREFIX}terms-${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const id = created.json().id as string;

    // GET with no stored terms → pre-filled defaults (all three kinds present).
    const initial = await app.inject({ method: 'GET', url: `/quotes/${id}/terms`, headers: authHeader() });
    expect(initial.statusCode).toBe(200);
    const initialRows = initial.json() as Array<{ kind: string; text: string }>;
    expect(initialRows.length).toBeGreaterThan(0);
    expect(initialRows.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['assumption', 'exclusion', 'term']),
    );

    // PUT replaces the whole set; seq derives from index.
    const put = await app.inject({
      method: 'PUT',
      url: `/quotes/${id}/terms`,
      headers: authHeader(),
      payload: {
        terms: [
          { kind: 'assumption', text: 'Custom assumption A' },
          { kind: 'exclusion', text: 'Custom exclusion X' },
          { kind: 'term', text: 'Custom term 1' },
          { kind: 'term', text: 'Custom term 2' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json() as Array<{ kind: string; text: string }>;
    expect(saved).toHaveLength(4);
    expect(saved[3]).toMatchObject({ kind: 'term', text: 'Custom term 2' });

    // GET now returns the stored set, not the defaults.
    const after = await app.inject({ method: 'GET', url: `/quotes/${id}/terms`, headers: authHeader() });
    expect((after.json() as unknown[]).length).toBe(4);

    // The PDF still exports cleanly (now rendering the stored terms).
    const pdf = await app.inject({ method: 'GET', url: `/quotes/${id}/export.pdf`, headers: authHeader() });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    // Invalid input (empty text) → 422.
    const bad = await app.inject({
      method: 'PUT',
      url: `/quotes/${id}/terms`,
      headers: authHeader(),
      payload: { terms: [{ kind: 'term', text: '' }] },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('soft-deletes (archives) and restores a quote, preserving the row and audit (P1-05.1)', async () => {
    const jobReference = `${JOB_PREFIX}arch-${Math.floor(Math.random() * 1e9)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: authHeader(),
      payload: { jobReference, currencyCode: 'AUD' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // Active by default → appears in the default list.
    const activeBefore = await app.inject({ method: 'GET', url: '/quotes', headers: authHeader() });
    expect((activeBefore.json() as Array<{ id: string }>).map((q) => q.id)).toContain(id);

    // Archive it.
    const archived = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/archive`,
      headers: authHeader(),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).not.toBeNull();

    // Gone from the default (active) list…
    const activeList = await app.inject({ method: 'GET', url: '/quotes', headers: authHeader() });
    expect((activeList.json() as Array<{ id: string }>).map((q) => q.id)).not.toContain(id);

    // …but present in the archived view, and still readable directly (row preserved, not hard-deleted).
    const archivedList = await app.inject({ method: 'GET', url: '/quotes?archived=true', headers: authHeader() });
    expect((archivedList.json() as Array<{ id: string }>).map((q) => q.id)).toContain(id);
    const stillThere = await app.inject({ method: 'GET', url: `/quotes/${id}`, headers: authHeader() });
    expect(stillThere.statusCode).toBe(200);

    // Audit trail records the archive transition.
    const audit = await app.inject({ method: 'GET', url: `/quotes/${id}/audit`, headers: authHeader() });
    const archivedChange = (audit.json() as Array<{ fieldName: string | null; newValue: string | null }>).find(
      (a) => a.fieldName === 'archived' && a.newValue === 'true',
    );
    expect(archivedChange).toBeTruthy();

    // Restore brings it back to the active list and clears archivedAt.
    const restored = await app.inject({
      method: 'POST',
      url: `/quotes/${id}/restore`,
      headers: authHeader(),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().archivedAt).toBeNull();
    const activeAfter = await app.inject({ method: 'GET', url: '/quotes', headers: authHeader() });
    expect((activeAfter.json() as Array<{ id: string }>).map((q) => q.id)).toContain(id);
  });
});
