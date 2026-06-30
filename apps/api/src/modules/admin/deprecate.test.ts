import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Deprecate-not-delete (P1-08.4 / P1-11.4): a catalog row referenced by a saved quote must be
 * deprecated (retained for old quotes, hidden from new ones) rather than hard-deleted; an
 * unreferenced row still hard-deletes.
 */
const JOB_PREFIX = `TESTDEP-${process.pid}-`;
const TAG = `ZZDEP-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
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
  await prisma.ledProduct.deleteMany({ where: { model: { startsWith: TAG } } });
  await app.close();
  await prisma.$disconnect();
});

describe('deprecate-not-delete for referenced catalog rows', () => {
  it('deprecates a referenced LED product, hard-deletes an unreferenced one, and keeps old quotes resolvable', async () => {
    // A fully-spec'd LED product we own (so it can be configured/priced + then referenced).
    const referenced = await prisma.ledProduct.create({
      data: {
        vendor: 'ZZTest',
        model: `${TAG}-REF`,
        minCabinetWMm: 320,
        minCabinetHMm: 320,
        pixelPitchH: 2.5,
        pixelPitchV: 2.5,
        kgPerSqm: 20,
        costPerSqmUsd: 800,
      },
    });
    const refId = Number(referenced.id);

    // Create a quote and attach an LED screen → quote_led_screens.led_product_id FK to it.
    const created = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: auth(),
      payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD' },
    });
    const quoteId = created.json().id as string;
    const led = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/led-screens`,
      headers: auth(),
      payload: { ledProductId: refId, desiredWidthMm: 1120, desiredHeightMm: 1920, rotateCabinets: true },
    });
    expect(led.statusCode).toBe(201);

    // Pre-deprecation the product appears in NEW configs (activeOnly path used by the wizard).
    const cfgBefore = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/screens/configure`,
      headers: auth(),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
    });
    const optsBefore = (cfgBefore.json() as { options: Array<{ model: string }> }).options;
    expect(optsBefore.some((o) => o.model === referenced.model)).toBe(true);

    // DELETE the referenced product → NOT a hard delete: 200 + deprecated flag.
    const del = await app.inject({ method: 'DELETE', url: `/admin/led-products/${refId}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    const delBody = del.json() as { deprecated: boolean; message: string };
    expect(delBody.deprecated).toBe(true);
    expect(delBody.message).toMatch(/deprecated instead of deleted/i);

    // The row still exists, now flagged deprecated.
    const still = await prisma.ledProduct.findUnique({ where: { id: referenced.id } });
    expect(still).toBeTruthy();
    expect(still!.deprecated).toBe(true);

    // An admin audit row was written recording the deprecation (action 'update' + reason note).
    const adminAudit = await prisma.adminAuditLog.findFirst({
      where: { tableName: 'led-products', recordId: refId.toString(), action: 'update' },
      orderBy: { id: 'desc' },
    });
    expect(adminAudit).toBeTruthy();
    expect(JSON.stringify(adminAudit!.changes)).toMatch(/deprecated/i);

    // Excluded from ?activeOnly=true (used by NEW-quote pickers)…
    const active = await app.inject({
      method: 'GET',
      url: `/admin/led-products?activeOnly=true&take=500&q=${TAG}`,
      headers: auth(),
    });
    const activeRows = (active.json() as { rows: Array<{ id: string }> }).rows;
    expect(activeRows.some((r) => Number(r.id) === refId)).toBe(false);

    // …but still visible to the admin management grid (no activeOnly) so it can be un-deprecated.
    const all = await app.inject({
      method: 'GET',
      url: `/admin/led-products?take=500&q=${TAG}`,
      headers: auth(),
    });
    const allRows = (all.json() as { rows: Array<{ id: string }> }).rows;
    expect(allRows.some((r) => Number(r.id) === refId)).toBe(true);

    // Excluded from the config engine (NEW configs no longer rank it).
    const cfgAfter = await app.inject({
      method: 'POST',
      url: `/quotes/${quoteId}/screens/configure`,
      headers: auth(),
      payload: { desiredWidthMm: 1120, desiredHeightMm: 1920 },
    });
    const optsAfter = (cfgAfter.json() as { options: Array<{ model: string }> }).options;
    expect(optsAfter.some((o) => o.model === referenced.model)).toBe(false);

    // The existing quote still resolves its (now-deprecated) referenced product.
    const quote = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth() });
    const screens = (quote.json() as { ledScreens: Array<{ ledProductId: string | null }> }).ledScreens;
    expect(screens[0]!.ledProductId).toBe(refId.toString());

    // An UNREFERENCED product hard-deletes as before (204, row gone).
    const orphan = await prisma.ledProduct.create({
      data: { vendor: 'ZZTest', model: `${TAG}-ORPHAN`, minCabinetWMm: 320, minCabinetHMm: 320, pixelPitchH: 2.5 },
    });
    const orphanId = Number(orphan.id);
    const delOrphan = await app.inject({ method: 'DELETE', url: `/admin/led-products/${orphanId}`, headers: auth() });
    expect(delOrphan.statusCode).toBe(204);
    const goneOrphan = await prisma.ledProduct.findUnique({ where: { id: orphan.id } });
    expect(goneOrphan).toBeNull();

    // Un-deprecate via the generic PATCH form (admin toggling the flag back on).
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/led-products/${refId}`,
      headers: auth(),
      payload: { deprecated: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().deprecated).toBe(false);
  });
});
