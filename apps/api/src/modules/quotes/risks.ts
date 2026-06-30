import { prisma } from '@quotezen/db';
import type { QuoteRisksInput, RiskCategory, RiskSeverity } from '@quotezen/shared';
import { recordAudit } from '../../services/audit.js';
import { getQuote } from './service.js';
import { getTerms } from './terms.js';

/**
 * Manual assumptions & risks register (T4 / Workshop "Capability 2", FR-038–041 risks, FR-095
 * assumptions). Manual capture only — AI gap/risk detection stays deferred. Assumptions reuse
 * `quote_terms` (kind=assumption); this is the risks half + the combined register read.
 */

export interface QuoteRiskOut {
  category: RiskCategory;
  description: string;
  severity: RiskSeverity;
  mitigation: string | null;
  seq: number;
}

/** A quote's risks ordered by seq. */
export const getRisks = async (id: bigint): Promise<QuoteRiskOut[]> => {
  await getQuote(id); // 404 if missing
  const rows = await prisma.quoteRisk.findMany({ where: { quoteId: id }, orderBy: { seq: 'asc' } });
  return rows.map((r) => ({
    category: r.category as RiskCategory,
    description: r.description,
    severity: r.severity as RiskSeverity,
    mitigation: r.mitigation,
    seq: r.seq,
  }));
};

/** Replace the whole risk set (deleteMany + createMany, seq = index), audited. */
export const replaceRisks = async (
  userId: bigint,
  id: bigint,
  input: QuoteRisksInput,
): Promise<QuoteRiskOut[]> => {
  await getQuote(id); // 404 if missing

  return prisma.$transaction(async (tx) => {
    await tx.quoteRisk.deleteMany({ where: { quoteId: id } });
    if (input.risks.length > 0) {
      await tx.quoteRisk.createMany({
        data: input.risks.map((r, i) => ({
          quoteId: id,
          seq: i,
          category: r.category,
          description: r.description,
          severity: r.severity,
          mitigation: r.mitigation ?? null,
        })),
      });
    }
    await recordAudit(tx, {
      quoteId: id,
      userId,
      action: 'update',
      entityTable: 'quote_risks',
      entityId: id,
      changes: [{ field: 'risks', oldValue: null, newValue: `${input.risks.length} risk(s)` }],
    });
    const rows = await tx.quoteRisk.findMany({ where: { quoteId: id }, orderBy: { seq: 'asc' } });
    return rows.map((r) => ({
      category: r.category as RiskCategory,
      description: r.description,
      severity: r.severity as RiskSeverity,
      mitigation: r.mitigation,
      seq: r.seq,
    }));
  });
};

/**
 * The combined highlighted register the UI shows pre-finalisation: assumptions (from terms
 * kind=assumption) + risks, in one payload so the client need not stitch two calls.
 */
export const getRegister = async (id: bigint): Promise<{ assumptions: string[]; risks: QuoteRiskOut[] }> => {
  const [terms, risks] = await Promise.all([getTerms(id), getRisks(id)]);
  return {
    assumptions: terms.filter((t) => t.kind === 'assumption').map((t) => t.text),
    risks,
  };
};
