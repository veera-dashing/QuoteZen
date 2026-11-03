import { prisma } from '@quotezen/db';
import type { AppConfig } from '../../config.js';
import { AppError, notFound } from '../../errors.js';
import { recordAudit } from '../../services/audit.js';
import { loadRatios } from '../quotes/outputs.js';
import { buildQuotePdf } from '../quotes/pdf.js';
import { getQuote, listLicenceComponents, type Actor } from '../quotes/service.js';
import { uploadDealAttachment, zohoSettings } from './client.js';

/**
 * Phase 2 output: attach the quote's PDF to the Zoho deal it came from. Runs automatically when a
 * Zoho-linked quote becomes `approved` (human-approved — BR-001), and on demand for a resend.
 * The approval itself never depends on Zoho: the automatic send runs after the approval commits.
 */

/** Attachment file name: job reference + revision, so every approved revision stays on the deal. */
export const quotePdfFileName = (jobReference: string, revision: number): string =>
  `Quote-${jobReference.replace(/[^\w.-]+/g, '_')}-rev${revision}.pdf`;

export interface PdfSendResult {
  dealId: string;
  fileName: string;
  zohoAttachmentId: string;
}

export const sendQuotePdfToZoho = async (config: AppConfig, actor: Actor, quoteId: bigint): Promise<PdfSendResult> => {
  const quote = await getQuote(quoteId);
  if (!quote) throw notFound('Quote', quoteId.toString());
  if (!quote.zohoDealId) throw new AppError('bad_request', 'This quote is not linked to a Zoho deal');

  const [ratios, licenceRows] = await Promise.all([loadRatios(), listLicenceComponents()]);
  const pdf = await buildQuotePdf(quote, ratios, licenceRows);
  const fileName = quotePdfFileName(quote.jobReference, quote.lockVersion);
  const zohoAttachmentId = await uploadDealAttachment(zohoSettings(config), quote.zohoDealId, fileName, 'application/pdf', pdf);

  // Record the outbound send on the quote's trail (who, which file, which deal, which revision).
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'update',
      entityTable: 'quotes',
      entityId: quoteId,
      changes: [
        {
          field: 'zoho_pdf_sent',
          oldValue: null,
          newValue: `${fileName} → deal ${quote.zohoDealId} (attachment ${zohoAttachmentId}, status ${quote.status})`,
        },
      ],
    });
  });
  return { dealId: quote.zohoDealId, fileName, zohoAttachmentId };
};

type Log = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

/**
 * After a status change/review: if the quote is now `approved` and came from Zoho, send the PDF in
 * the background (after the response — no extra work on the request path). Approval is only
 * reachable from a review stage, so this fires once per approval. Failures are logged (and can be
 * resent manually) — they never undo an approval.
 */
export const afterStatusChange = (
  config: AppConfig,
  actor: Actor,
  quoteId: bigint,
  newStatus: string,
  log: Log,
): void => {
  if (newStatus !== 'approved') return;
  setImmediate(() => {
    void (async () => {
      try {
        const linked = await prisma.quote.findUnique({ where: { id: quoteId }, select: { zohoDealId: true } });
        if (!linked?.zohoDealId) return; // manual quote — nothing to send
        const result = await sendQuotePdfToZoho(config, actor, quoteId);
        log.info({ quoteId: quoteId.toString(), ...result }, 'zoho: approved quote PDF attached to deal');
      } catch (err) {
        log.error({ quoteId: quoteId.toString(), err: err instanceof Error ? err.message : String(err) }, 'zoho: PDF send failed');
      }
    })();
  });
};
