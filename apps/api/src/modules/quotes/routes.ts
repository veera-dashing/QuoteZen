import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  changeStatusSchema,
  createQuoteSchema,
  lcdScreenSchema,
  listQuotesQuerySchema,
  ledScreenSchema,
  quoteLicenceSchema,
  quoteTermsSchema,
  reorderScreensSchema,
  screenQtySchema,
  setOverrideSchema,
  updateQuoteSchema,
} from '@quotezen/shared';
import { parse } from '../../lib/validate.js';
import type { UserRole } from '@quotezen/shared';
import {
  archiveQuote,
  assertOwnership,
  changeStatus,
  clearOverride,
  createQuote,
  restoreQuote,
  getAllAuditLog,
  getAuditLog,
  getOverrides,
  getQuote,
  getQuotes,
  priceQuote,
  recomputeQuote,
  setOverride,
  updateQuote,
  type Actor,
} from './service.js';
import { listKbEntries } from './kb.js';
import { validateQuote } from './validate.js';

const auditFilterQuery = z.object({
  field: z.string().optional(),
  userId: z.coerce.bigint().optional(),
  action: z.enum(['create', 'update', 'delete', 'status_change']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
import {
  addLcdScreen,
  addLedScreen,
  addLicence,
  configureForQuote,
  deleteLedScreen,
  duplicateLedScreen,
  reorderLedScreens,
  setLedScreenQty,
} from './screens.js';
import { buildQuotePdf } from './pdf.js';
import { buildBom, buildDescriptions, buildPmHandoff, buildSolutionSummary, loadRatios } from './outputs.js';
import { getTerms, replaceTerms } from './terms.js';
import {
  createVersion,
  diffVersions,
  getVersionSnapshot,
  listVersions,
  rollbackToVersion,
} from './versioning.js';

const revParam = z.object({ id: z.coerce.bigint(), rev: z.coerce.number().int().positive() });
const diffQuery = z.object({ a: z.coerce.number().int().positive(), b: z.coerce.number().int().positive() });

const configureSchema = z.object({
  desiredWidthMm: z.coerce.number().int().positive(),
  desiredHeightMm: z.coerce.number().int().positive(),
  allowRotation: z.boolean().optional(),
});

const idParam = z.object({ id: z.coerce.bigint() });

export const quoteRoutes = async (app: FastifyInstance): Promise<void> => {
  const auth = { preHandler: [app.authenticate] };
  // Mutations require a writer role; `viewer` is read-only (P1-19g.1 RBAC).
  const write = { preHandler: [app.requireRole('admin', 'sales')] };
  const userId = (request: { user: { id: string } }): bigint => BigInt(request.user.id);
  const actor = (request: { user: { id: string; role: UserRole } }): Actor => ({
    id: BigInt(request.user.id),
    role: request.user.role,
  });

  app.get('/quotes', auth, (request) => {
    const { archived } = parse(listQuotesQuerySchema, request.query);
    return getQuotes(actor(request), { archived });
  });

  app.post('/quotes', write, async (request, reply) => {
    const input = parse(createQuoteSchema, request.body);
    const quote = await createQuote(userId(request), input);
    return reply.code(201).send(quote);
  });

  app.get('/quotes/:id', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getQuote(id);
  });

  app.patch('/quotes/:id', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(updateQuoteSchema, request.body);
    return updateQuote(userId(request), id, input);
  });

  // Soft-delete / restore (P1-05.1): the row + audit are preserved; the quote is hidden from the
  // default list. Writers only; ownership enforced.
  app.post('/quotes/:id/archive', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return archiveQuote(userId(request), id);
  });

  app.post('/quotes/:id/restore', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return restoreQuote(userId(request), id);
  });

  app.post('/quotes/:id/status', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { status, reason } = parse(changeStatusSchema, request.body);
    return changeStatus(actor(request), id, status, reason);
  });

  app.post('/quotes/:id/recompute', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return recomputeQuote(userId(request), id);
  });

  // Fully itemised price (every line), cost masked for non-admin (P1-16.8 / BR-081).
  app.post('/quotes/:id/price', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return priceQuote(actor(request), id);
  });

  // ── Manual price overrides (P1-17): pinned-override recalc ──
  app.get('/quotes/:id/overrides', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getOverrides(id);
  });

  app.post('/quotes/:id/overrides', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(setOverrideSchema, request.body);
    return setOverride(actor(request), id, input);
  });

  app.delete('/quotes/:id/overrides/:overrideId', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { overrideId } = parse(z.object({ overrideId: z.coerce.bigint() }), request.params);
    return clearOverride(actor(request), id, overrideId);
  });

  // Conflict / validation engine (P1-15): per-screen findings + can-finalise gate.
  app.get('/quotes/:id/validate', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return validateQuote(id);
  });

  app.get('/quotes/:id/audit', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getAuditLog(id, parse(auditFilterQuery, request.query));
  });

  // Cross-quote audit feed + knowledge base (admin / sales — sensitive commercial history).
  app.get('/admin/audit', { preHandler: [app.requireRole('admin')] }, (request) =>
    getAllAuditLog(parse(auditFilterQuery, request.query)),
  );

  app.get('/kb', { preHandler: [app.requireRole('admin', 'sales')] }, (request) =>
    listKbEntries(parse(z.object({ outcome: z.string().optional(), client: z.string().optional() }), request.query)),
  );

  app.get('/quotes/:id/export.pdf', auth, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const [quote, ratios] = await Promise.all([getQuote(id), loadRatios()]);
    const pdf = await buildQuotePdf(quote, ratios);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="quote-${quote.jobReference}.pdf"`)
      .send(pdf);
  });

  // ── Quote outputs (P1-18) ──
  app.get('/quotes/:id/descriptions', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const [quote, ratios] = await Promise.all([getQuote(id), loadRatios()]);
    return buildDescriptions(quote, ratios);
  });

  app.get('/quotes/:id/bom', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const [quote, ratios] = await Promise.all([getQuote(id), loadRatios()]);
    return buildBom(quote, actor(request).role === 'admin', ratios);
  });

  app.get('/quotes/:id/solution-summary', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return buildSolutionSummary(await getQuote(id), actor(request).role === 'admin');
  });

  app.get('/quotes/:id/pm-handoff', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return buildPmHandoff(await getQuote(id));
  });

  // ── Editable proposal text (P1-18.2): assumptions / exclusions / T&Cs ──
  app.get('/quotes/:id/terms', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getTerms(id);
  });

  app.put('/quotes/:id/terms', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(quoteTermsSchema, request.body);
    return replaceTerms(userId(request), id, input);
  });

  // ── Versioning & snapshots (P1-04) ──
  app.post('/quotes/:id/versions', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { label } = parse(z.object({ label: z.string().max(120).optional() }), request.body ?? {});
    const version = await createVersion(actor(request), id, label);
    return reply.code(201).send(version);
  });

  app.get('/quotes/:id/versions', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return listVersions(id);
  });

  app.get('/quotes/:id/versions/diff', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { a, b } = parse(diffQuery, request.query);
    return diffVersions(id, a, b);
  });

  app.get('/quotes/:id/versions/:rev', auth, async (request) => {
    const { id, rev } = parse(revParam, request.params);
    await assertOwnership(id, actor(request));
    return getVersionSnapshot(id, rev);
  });

  app.post('/quotes/:id/versions/:rev/rollback', write, async (request, reply) => {
    const { id, rev } = parse(revParam, request.params);
    await assertOwnership(id, actor(request));
    const version = await rollbackToVersion(actor(request), id, rev);
    return reply.code(201).send(version);
  });

  // ── Technical configuration engine (P1-13): ranked valid configs for an opening ──
  app.post('/quotes/:id/screens/configure', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const body = parse(configureSchema, request.body);
    return configureForQuote(id, body);
  });

  // ── Child line items (wizard steps) ──
  app.post('/quotes/:id/led-screens', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(ledScreenSchema, request.body);
    const screen = await addLedScreen(userId(request), id, input);
    return reply.code(201).send(screen);
  });

  app.delete('/quotes/:id/led-screens/:screenId', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    await deleteLedScreen(userId(request), id, screenId);
    return reply.code(204).send();
  });

  // Reorder LED screens (P1-14.1): full ordered id list → sortOrder by index.
  app.post('/quotes/:id/led-screens/reorder', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { orderedIds } = parse(reorderScreensSchema, request.body);
    await reorderLedScreens(userId(request), id, orderedIds);
    return recomputeQuote(userId(request), id);
  });

  // Duplicate an LED screen (P1-14.1): deep-copy row + children, recompute.
  app.post('/quotes/:id/led-screens/:screenId/duplicate', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    const screen = await duplicateLedScreen(userId(request), id, screenId);
    await recomputeQuote(userId(request), id);
    return reply.code(201).send(screen);
  });

  // Per-screen quantity (P1-14.2): update qty, then recompute the rollup.
  app.patch('/quotes/:id/led-screens/:screenId/qty', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    const { qty } = parse(screenQtySchema, request.body);
    await setLedScreenQty(userId(request), id, screenId, qty);
    return recomputeQuote(userId(request), id);
  });

  app.post('/quotes/:id/lcd-screens', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(lcdScreenSchema, request.body);
    const screen = await addLcdScreen(userId(request), id, input);
    return reply.code(201).send(screen);
  });

  app.post('/quotes/:id/licences', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(quoteLicenceSchema, request.body);
    const licence = await addLicence(userId(request), id, input);
    return reply.code(201).send(licence);
  });
};
