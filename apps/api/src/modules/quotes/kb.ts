import { prisma } from '@quotezen/db';
import type { Db } from '../../services/audit.js';
import type { QuoteWithChildren } from './repository.js';

/**
 * Knowledge-base capture (P1-19f). When a quote reaches an outcome state it is snapshotted into
 * `kb_entries` with structured metadata. Storage only — no querying/AI in Phase 1; this is the corpus
 * for later KB-similarity and learning. One row per quote (upsert), captured inside the status txn.
 */
export const CAPTURE_STATUSES = ['issued', 'won', 'lost'];

const productModels = (quote: QuoteWithChildren): string => {
  const models = new Set<string>();
  for (const s of quote.ledScreens) if (s.ledProduct?.model) models.add(s.ledProduct.model);
  for (const s of quote.lcdScreens) if (s.display?.model) models.add(s.display.model);
  return [...models].join(', ');
};

export const captureKbEntry = async (
  db: Db,
  quote: QuoteWithChildren,
  capturedById: bigint,
  outcome: string,
  margin: string | null,
): Promise<void> => {
  const data = {
    jobReference: quote.jobReference,
    clientName: quote.client?.name ?? null,
    locationName: quote.location?.name ?? null,
    screenCount: quote.ledScreens.length + quote.lcdScreens.length,
    productModels: productModels(quote) || null,
    grandTotal: quote.grandTotal,
    margin,
    outcome,
    capturedById,
  };
  await db.kbEntry.upsert({
    where: { quoteId: quote.id },
    create: { quoteId: quote.id, ...data },
    update: data,
  });
};

export interface KbFilters {
  outcome?: string;
  client?: string;
}

export const listKbEntries = (filters: KbFilters) =>
  prisma.kbEntry.findMany({
    where: {
      outcome: filters.outcome,
      clientName: filters.client ? { contains: filters.client, mode: 'insensitive' } : undefined,
    },
    orderBy: { capturedAt: 'desc' },
    take: 500,
  });
