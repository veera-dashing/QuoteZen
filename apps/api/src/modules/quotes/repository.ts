import { prisma } from '@quotezen/db';
import type { Prisma } from '@quotezen/db';

/** Data-access for quotes. No business logic here — services compose these + audit. */

/** Children needed to recompute totals and render the full quote. */
export const quoteInclude = {
  client: true,
  location: true,
  currency: true,
  ledScreens: { include: { components: true, costBreakdown: true } },
  lcdScreens: { include: { items: true } },
  mediaplayers: { include: { mediaplayer: true } },
  peripherals: { include: { peripheral: true } },
  manufacturedItems: { include: { product: true } },
  audioItems: { include: { audioProduct: true } },
  musicItems: { include: { musicService: true } },
  hypervsnItems: { include: { hypervsnProduct: true } },
  softwareItems: { include: { softwareActivity: true } },
  licences: { include: { licenceComponent: true } },
  terms: { orderBy: { seq: 'asc' } },
} satisfies Prisma.QuoteInclude;

export type QuoteWithChildren = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>;

export const findQuoteById = (id: bigint): Promise<QuoteWithChildren | null> =>
  prisma.quote.findUnique({ where: { id }, include: quoteInclude });

export const findQuoteByJobRef = (jobReference: string) =>
  prisma.quote.findUnique({ where: { jobReference } });

export const listQuotes = (where?: Prisma.QuoteWhereInput) =>
  prisma.quote.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { client: true, currency: true },
  });

export const findCurrencyByCode = (code: string) => prisma.currency.findUnique({ where: { code } });

export const listAuditLog = (quoteId: bigint) =>
  prisma.quoteAuditLog.findMany({
    where: { quoteId },
    orderBy: { changedAt: 'desc' },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
