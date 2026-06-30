import { prisma } from '@quotezen/db';
import type { QuoteTermsInput, TermKind } from '@quotezen/shared';
import { recordAudit } from '../../services/audit.js';
import { getQuote } from './service.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EXCLUSIONS, DEFAULT_TERMS } from './outputs.js';

export interface QuoteTermOut {
  kind: TermKind;
  text: string;
}

/** The default starting set, used to pre-fill the editor when a quote has no stored terms yet. */
const defaultTerms = (): QuoteTermOut[] => [
  ...DEFAULT_ASSUMPTIONS.map((text): QuoteTermOut => ({ kind: 'assumption', text })),
  ...DEFAULT_EXCLUSIONS.map((text): QuoteTermOut => ({ kind: 'exclusion', text })),
  ...DEFAULT_TERMS.map((text): QuoteTermOut => ({ kind: 'term', text })),
];

/**
 * The quote's proposal text ordered by seq. If none stored yet, returns the DEFAULT_* sets so the
 * editor pre-fills sensibly (these defaults are not persisted until the user saves).
 */
export const getTerms = async (id: bigint): Promise<QuoteTermOut[]> => {
  await getQuote(id); // 404 if missing
  const rows = await prisma.quoteTerm.findMany({ where: { quoteId: id }, orderBy: { seq: 'asc' } });
  if (rows.length === 0) return defaultTerms();
  return rows.map((r) => ({ kind: r.kind as TermKind, text: r.text }));
};

/** Replace the whole proposal-text set (deleteMany + createMany, seq = index), audited. */
export const replaceTerms = async (
  userId: bigint,
  id: bigint,
  input: QuoteTermsInput,
): Promise<QuoteTermOut[]> => {
  await getQuote(id); // 404 if missing

  return prisma.$transaction(async (tx) => {
    await tx.quoteTerm.deleteMany({ where: { quoteId: id } });
    if (input.terms.length > 0) {
      await tx.quoteTerm.createMany({
        data: input.terms.map((t, i) => ({ quoteId: id, seq: i, kind: t.kind, text: t.text })),
      });
    }
    await recordAudit(tx, {
      quoteId: id,
      userId,
      action: 'update',
      entityTable: 'quote_terms',
      entityId: id,
      changes: [{ field: 'terms', oldValue: null, newValue: `${input.terms.length} line(s)` }],
    });
    const rows = await tx.quoteTerm.findMany({ where: { quoteId: id }, orderBy: { seq: 'asc' } });
    return rows.map((r) => ({ kind: r.kind as TermKind, text: r.text }));
  });
};
