import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import {
  changeStatusSchema,
  createQuoteSchema,
  lcdScreenSchema,
  lineDiscountSchema,
  recordReviewSchema,
  listQuotesQuerySchema,
  ledScreenSchema,
  quoteLicenceSchema,
  quoteRisksSchema,
  quoteTermsSchema,
  reorderScreensSchema,
  screenQtySchema,
  setOverrideSchema,
  updateLedScreenSchema,
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
  getDiscountCapPct,
  getDiscountNoteThresholdPct,
  getOverrides,
  getQuote,
  getQuotes,
  priceQuote,
  recomputePreview,
  recomputeQuote,
  setLcdItemDiscount,
  setLedLineDiscount,
  setOverride,
  updateQuote,
  type Actor,
} from './service.js';
import { listKbEntries } from './kb.js';
import { listReviews, recordReview } from './reviews.js';
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
  optionsForQuote,
  lcdOptionsForQuote,
  deleteLedScreen,
  duplicateLedScreen,
  reorderLedScreens,
  setLedScreenQty,
  updateLedScreen,
  updateLedScreenFull,
  updateLcdScreen,
} from './screens.js';
import { buildQuotePdf } from './pdf.js';
import { buildBom, buildDescriptions, buildPmHandoff, buildSolutionSummary, loadRatios } from './outputs.js';
import { getTerms, replaceTerms } from './terms.js';
import { getRegister, getRisks, replaceRisks } from './risks.js';
import {
  createVersion,
  diffVersions,
  getVersionSnapshot,
  listVersions,
  rerunQuote,
  rollbackToVersion,
} from './versioning.js';
import { deleteDocument, getDocumentFile, listDocuments, saveDocument } from './documents.js';

const revParam = z.object({ id: z.coerce.bigint(), rev: z.coerce.number().int().positive() });
const diffQuery = z.object({ a: z.coerce.number().int().positive(), b: z.coerce.number().int().positive() });

const configureSchema = z.object({
  desiredWidthMm: z.coerce.number().int().positive(),
  desiredHeightMm: z.coerce.number().int().positive(),
  allowRotation: z.boolean().optional(),
  // W0: optional environment + viewing-distance filters (absent → unchanged behaviour).
  environment: z.enum(['indoor', 'outdoor']).optional(),
  viewingDistanceM: z.coerce.number().positive().optional(),
});

// AA3b: LCD Good/Better/Best — optional target size + category filter (all optional → catalogue-wide).
const lcdOptionsSchema = z.object({
  targetSizeIn: z.coerce.number().positive().optional(),
  category: z.string().min(1).optional(),
});

const idParam = z.object({ id: z.coerce.bigint() });

export const quoteRoutes = async (
  app: FastifyInstance,
  opts: { config: AppConfig },
): Promise<void> => {
  const uploadDir = opts.config.UPLOAD_DIR;
  const auth = { preHandler: [app.authenticate] };
  // Mutations require a writer role; `viewer` is read-only (P1-19g.1 RBAC).
  // Internal staff who can operate on quotes: authors (admin/sales) + approvers (director/manager).
  const write = { preHandler: [app.requireRole('admin', 'sales', 'director', 'manager')] };
  const userId = (request: { user: { id: string } }): bigint => BigInt(request.user.id);
  const actor = (request: { user: { id: string; role: UserRole } }): Actor => ({
    id: BigInt(request.user.id),
    role: request.user.role,
  });

  app.get('/quotes', auth, (request) => {
    const { archived, status, clientId, q, from, to } = parse(listQuotesQuerySchema, request.query);
    return getQuotes(actor(request), { archived, status, clientId, q, from, to });
  });

  // The quote-level discount policy (cap + note threshold, fractions 0..1) from the DB settings, so
  // the quote page can hard-limit the estimator's input to the admin-maintained cap. Any writer/reader.
  app.get('/quotes/discount-policy', auth, async () => {
    const [capPct, noteThresholdPct] = await Promise.all([
      getDiscountCapPct(),
      getDiscountNoteThresholdPct(),
    ]);
    return { capPct, noteThresholdPct };
  });

  app.post('/quotes', write, async (request, reply) => {
    const input = parse(createQuoteSchema, request.body);
    const quote = await createQuote(userId(request), input, actor(request).role);
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
    return updateQuote(userId(request), id, input, actor(request).role);
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

  // ── Two-stage Review & Approval (T1 / BR-001) ──
  // Record a technical/commercial review decision (advances or kicks back the workflow).
  app.post('/quotes/:id/reviews', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { stage, decision, comment } = parse(recordReviewSchema, request.body);
    const quote = await recordReview(actor(request), id, stage, decision, comment);
    return reply.code(201).send(quote);
  });

  // The immutable review history (preserved across revisions, FR-110).
  app.get('/quotes/:id/reviews', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return listReviews(id);
  });

  app.post('/quotes/:id/recompute', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return recomputeQuote(userId(request), id);
  });

  // Read-only recompute preview (P1-19d.3): "recomputing now would change X → Y" for a reopened
  // finished quote. Auth + ownership; never mutates (no `write` role, no persisted change).
  app.get('/quotes/:id/recompute-preview', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return recomputePreview(id);
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

  // ── Per-line discounts (V2): set/clear a per-line % on a LED cost line or an LCD item ──
  app.patch('/quotes/:id/led-lines/:lineId/discount', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { lineId } = parse(z.object({ lineId: z.coerce.bigint() }), request.params);
    const { discountPct } = parse(lineDiscountSchema, request.body);
    return setLedLineDiscount(actor(request), id, lineId, discountPct);
  });

  app.patch('/quotes/:id/lcd-items/:itemId/discount', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { itemId } = parse(z.object({ itemId: z.coerce.bigint() }), request.params);
    const { discountPct } = parse(lineDiscountSchema, request.body);
    return setLcdItemDiscount(actor(request), id, itemId, discountPct);
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

  app.get('/kb', { preHandler: [app.requireRole('admin', 'sales', 'director', 'manager')] }, (request) =>
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

  // ── Manual assumptions & risks register (T4 / FR-038–041, FR-095) ──
  app.get('/quotes/:id/risks', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getRisks(id);
  });

  app.put('/quotes/:id/risks', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(quoteRisksSchema, request.body);
    return replaceRisks(userId(request), id, input);
  });

  // Combined register (assumptions from terms + risks) for the pre-finalisation register view.
  app.get('/quotes/:id/register', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getRegister(id);
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

  // ── Good / Better / Best tiered options (T2 / FR-057 / FR-067): three priced tiers for an opening ──
  app.post('/quotes/:id/screens/options', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const body = parse(configureSchema, request.body);
    return optionsForQuote(id, body, actor(request).role === 'admin');
  });

  // ── LCD Good / Better / Best tiered options (AA3b): 2–3 display picks at different price points ──
  app.post('/quotes/:id/lcd-options', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const body = parse(lcdOptionsSchema, request.body ?? {});
    return lcdOptionsForQuote(id, body, actor(request).role === 'admin');
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

  // Edit a finalised LED screen's secondary options/services (U0): re-prices + recomputes.
  app.patch('/quotes/:id/led-screens/:screenId', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    const input = parse(updateLedScreenSchema, request.body);
    await updateLedScreen(userId(request), id, screenId, input);
    return recomputeQuote(userId(request), id);
  });

  // Full re-edit of a LED screen (V3): the whole add form pre-filled — any field changeable
  // (product + geometry + components + options). Re-prices via the same path as add, recomputes,
  // preserves id/sortOrder/qty. Returns the updated screen with its children.
  app.put('/quotes/:id/led-screens/:screenId', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    const input = parse(ledScreenSchema, request.body);
    return updateLedScreenFull(userId(request), id, screenId, input);
  });

  app.post('/quotes/:id/lcd-screens', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(lcdScreenSchema, request.body);
    const screen = await addLcdScreen(userId(request), id, input);
    return reply.code(201).send(screen);
  });

  // Full re-edit of a LCD screen (V3): replaces fields + line items, re-prices via the same path
  // as add, recomputes, preserves id/sortOrder. Returns the updated screen with its items.
  app.put('/quotes/:id/lcd-screens/:screenId', write, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    const input = parse(lcdScreenSchema, request.body);
    return updateLcdScreen(userId(request), id, screenId, input);
  });

  app.post('/quotes/:id/licences', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(quoteLicenceSchema, request.body);
    const licence = await addLicence(userId(request), id, input);
    return reply.code(201).send(licence);
  });

  // ── Per-job documents + deterministic re-run (P1-19e) ──
  // Upload a file (multipart). Writers only; ownership enforced. Stored on local disk under a
  // generated name; mime/size validated; re-uploading the same name bumps the version.
  app.post('/quotes/:id/documents', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const file = await request.file();
    if (!file) throw new AppError('bad_request', 'No file provided in the multipart request');
    const doc = await saveDocument(actor(request), id, file, uploadDir);
    return reply.code(201).send(doc);
  });

  app.get('/quotes/:id/documents', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return listDocuments(id);
  });

  // Download a stored document. Auth + ownership is the access gate (prototype signed-URL equivalent).
  app.get('/quotes/:id/documents/:docId/download', auth, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { docId } = parse(z.object({ docId: z.coerce.bigint() }), request.params);
    const doc = await getDocumentFile(id, docId, uploadDir);
    try {
      await stat(doc.path);
    } catch {
      throw new AppError('not_found', 'Stored file is missing on disk');
    }
    return reply
      .header('content-type', doc.mimeType)
      .header('content-disposition', `attachment; filename="${doc.originalName.replace(/"/g, '')}"`)
      .send(createReadStream(doc.path));
  });

  app.delete('/quotes/:id/documents/:docId', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { docId } = parse(z.object({ docId: z.coerce.bigint() }), request.params);
    await deleteDocument(actor(request), id, docId, uploadDir);
    return reply.code(204).send();
  });

  // Deterministic re-run (P1-19e.2): recompute + capture a new version with a change summary.
  app.post('/quotes/:id/rerun', write, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const version = await rerunQuote(actor(request), id);
    return reply.code(201).send(version);
  });
};
