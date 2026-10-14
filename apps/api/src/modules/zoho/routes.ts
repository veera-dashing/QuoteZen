import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { parse } from '../../lib/validate.js';
import { extractIntake, mimeFromFileName, type IntakeDocument } from '../ai/extract.js';
import { downloadDealAttachment, getDeal, listDealAttachments, listDeals, zohoSettings } from './client.js';

/**
 * Phase 2 intake: Zoho deal → attachments → AI-proposed quote-form values (P1-19b + P2-02).
 * Read-only against Zoho and the DB: nothing is created here yet — the result is what the
 * estimator will review before a draft quote is made.
 */
const dealParam = z.object({ dealId: z.string().regex(/^\d+$/, 'Zoho deal id is numeric') });

/** 20 MB per file: Gemini's Files API takes more, but customer briefs are far smaller. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

  app.post('/zoho/deals/:dealId/extract', { preHandler: [staff] }, async (request) => {
    const { dealId } = parse(dealParam, request.params);
    const zoho = zohoSettings(config);

    const deal = await getDeal(zoho, dealId);
    const attachments = await listDealAttachments(zoho, dealId);

    const docs: IntakeDocument[] = [];
    const skipped: { fileName: string; reason: string }[] = [];
    for (const a of attachments) {
      const mimeType = mimeFromFileName(a.File_Name);
      if (!mimeType) {
        skipped.push({ fileName: a.File_Name, reason: 'file type not readable by AI yet' });
        continue;
      }
      if (Number(a.Size) > MAX_FILE_BYTES) {
        skipped.push({ fileName: a.File_Name, reason: 'file larger than 20 MB' });
        continue;
      }
      docs.push({ fileName: a.File_Name, mimeType, data: await downloadDealAttachment(zoho, dealId, a.id) });
    }

    // Nothing for the AI to read → say so instead of spending a (rate-limited) AI call.
    if (docs.length === 0 && !deal.Description) {
      throw new AppError('bad_request', 'This deal has no readable attachments or description to extract from', {
        skipped,
      });
    }

    // The CRM record itself is context too (account/contact names, any description typed by sales).
    const context = [
      `Deal: ${deal.Deal_Name}`,
      deal.Account_Name ? `Account: ${deal.Account_Name.name}` : null,
      deal.Contact_Name ? `Contact: ${deal.Contact_Name.name}` : null,
      deal.Description ? `Description: ${deal.Description}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const { extraction, model, usage } = await extractIntake(config, docs, context);

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
      ai: { model, ...usage },
    };
  });
};
