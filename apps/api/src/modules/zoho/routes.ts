import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { parse } from '../../lib/validate.js';
import { listDeals, zohoSettings } from './client.js';
import { createDraftFromDeal, readDeal } from './intake.js';

/**
 * Phase 2 intake: Zoho deal → attachments → AI-proposed quote-form values (P1-19b + P2-02),
 * and → a DRAFT quote built by the normal configurator/pricing for the estimator to review.
 */
const dealParam = z.object({ dealId: z.string().regex(/^\d+$/, 'Zoho deal id is numeric') });

export const zohoRoutes = async (app: FastifyInstance, opts: { config: AppConfig }): Promise<void> => {
  const { config } = opts;
  // Estimating staff only — viewers never trigger external calls.
  const staff = app.requireRole('admin', 'sales', 'manager', 'director');

  app.get('/zoho/deals', { preHandler: [staff] }, async () => {
    const deals = await listDeals(zohoSettings(config));
    return deals.map((d) => ({
      id: d.id,
      name: d.Deal_Name,
      stage: d.Stage,
      account: d.Account_Name?.name ?? null,
      contact: d.Contact_Name?.name ?? null,
      closingDate: d.Closing_Date,
    }));
  });

  /** Preview only: what the AI reads from the deal. Nothing is written. */
  app.post('/zoho/deals/:dealId/extract', { preHandler: [staff] }, async (request) => {
    const { dealId } = parse(dealParam, request.params);
    const { deal, docs, skipped, extraction, ai } = await readDeal(config, dealId);
    return {
      deal: {
        id: deal.id,
        name: deal.Deal_Name,
        stage: deal.Stage,
        account: deal.Account_Name?.name ?? null,
        contact: deal.Contact_Name?.name ?? null,
      },
      documents: docs.map((d) => ({ fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.data.length })),
      skipped,
      extraction,
      ai,
    };
  });

  /** Create the draft quote from the deal (409 if this deal already has one). */
  app.post('/zoho/deals/:dealId/draft-quote', { preHandler: [staff] }, async (request, reply) => {
    const { dealId } = parse(dealParam, request.params);
    const actor = { id: BigInt(request.user.id), role: request.user.role };
    return reply.code(201).send(await createDraftFromDeal(config, actor, dealId));
  });
};
