import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  changeStatusSchema,
  createQuoteSchema,
  lcdScreenSchema,
  ledScreenSchema,
  quoteLicenceSchema,
  updateQuoteSchema,
} from '@quotezen/shared';
import { parse } from '../../lib/validate.js';
import type { UserRole } from '@quotezen/shared';
import {
  assertOwnership,
  changeStatus,
  createQuote,
  getAuditLog,
  getQuote,
  getQuotes,
  priceQuote,
  recomputeQuote,
  updateQuote,
  type Actor,
} from './service.js';
import { addLcdScreen, addLedScreen, addLicence, configureForQuote, deleteLedScreen } from './screens.js';
import { buildQuotePdf } from './pdf.js';
import { buildBom, buildDescriptions, buildPmHandoff, buildSolutionSummary, loadRatios } from './outputs.js';
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
  const userId = (request: { user: { id: string } }): bigint => BigInt(request.user.id);
  const actor = (request: { user: { id: string; role: UserRole } }): Actor => ({
    id: BigInt(request.user.id),
    role: request.user.role,
  });

  app.get('/quotes', auth, (request) => getQuotes(actor(request)));

  app.post('/quotes', auth, async (request, reply) => {
    const input = parse(createQuoteSchema, request.body);
    const quote = await createQuote(userId(request), input);
    return reply.code(201).send(quote);
  });

  app.get('/quotes/:id', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getQuote(id);
  });

  app.patch('/quotes/:id', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(updateQuoteSchema, request.body);
    return updateQuote(userId(request), id, input);
  });

  app.post('/quotes/:id/status', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { status, reason } = parse(changeStatusSchema, request.body);
    return changeStatus(actor(request), id, status, reason);
  });

  app.post('/quotes/:id/recompute', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return recomputeQuote(userId(request), id);
  });

  // Fully itemised price (every line), cost masked for non-admin (P1-16.8 / BR-081).
  app.post('/quotes/:id/price', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return priceQuote(actor(request), id);
  });

  app.get('/quotes/:id/audit', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    return getAuditLog(id);
  });

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

  // ── Versioning & snapshots (P1-04) ──
  app.post('/quotes/:id/versions', auth, async (request, reply) => {
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

  app.post('/quotes/:id/versions/:rev/rollback', auth, async (request, reply) => {
    const { id, rev } = parse(revParam, request.params);
    await assertOwnership(id, actor(request));
    const version = await rollbackToVersion(actor(request), id, rev);
    return reply.code(201).send(version);
  });

  // ── Technical configuration engine (P1-13): ranked valid configs for an opening ──
  app.post('/quotes/:id/screens/configure', auth, async (request) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const body = parse(configureSchema, request.body);
    return configureForQuote(id, body);
  });

  // ── Child line items (wizard steps) ──
  app.post('/quotes/:id/led-screens', auth, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(ledScreenSchema, request.body);
    const screen = await addLedScreen(userId(request), id, input);
    return reply.code(201).send(screen);
  });

  app.delete('/quotes/:id/led-screens/:screenId', auth, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const { screenId } = parse(z.object({ screenId: z.coerce.bigint() }), request.params);
    await deleteLedScreen(userId(request), id, screenId);
    return reply.code(204).send();
  });

  app.post('/quotes/:id/lcd-screens', auth, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(lcdScreenSchema, request.body);
    const screen = await addLcdScreen(userId(request), id, input);
    return reply.code(201).send(screen);
  });

  app.post('/quotes/:id/licences', auth, async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await assertOwnership(id, actor(request));
    const input = parse(quoteLicenceSchema, request.body);
    const licence = await addLicence(userId(request), id, input);
    return reply.code(201).send(licence);
  });
};
