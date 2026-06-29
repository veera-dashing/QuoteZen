import { prisma } from '@quotezen/db';
import { aggregateQuote, type QuoteLineContribution } from '@quotezen/calc';
import type { CreateQuoteInput, UpdateQuoteInput } from '@quotezen/shared';
import type { QuoteStatus } from '@quotezen/shared';
import { AppError, conflict, notFound } from '../../errors.js';
import type { UserRole } from '@quotezen/shared';
import { diffFields, recordAudit } from '../../services/audit.js';
import {
  findCurrencyByCode,
  findQuoteById,
  findQuoteByJobRef,
  listAuditLog,
  listQuotes,
  quoteInclude,
  type QuoteWithChildren,
} from './repository.js';

const QUOTE_HEADER_FIELDS = [
  'jobReference',
  'clientId',
  'locationId',
  'currencyId',
  'resellerMarkup',
  'validUntil',
  'requestedShippingDate',
] as const;

const dec = (v: { toString(): string } | null | undefined): string => (v ? v.toString() : '0');

export const createQuote = async (userId: bigint, input: CreateQuoteInput) => {
  if (await findQuoteByJobRef(input.jobReference)) {
    throw conflict(`Job reference "${input.jobReference}" already exists`);
  }
  const currency = await findCurrencyByCode(input.currencyCode);
  if (!currency) throw notFound('Currency', input.currencyCode);

  return prisma.$transaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        jobReference: input.jobReference,
        clientId: input.clientId ?? null,
        locationId: input.locationId ?? null,
        currencyId: currency.id,
        resellerMarkup: input.resellerMarkup,
        validUntil: input.validUntil ?? null,
        requestedShippingDate: input.requestedShippingDate ?? null,
        createdById: userId,
      },
      include: quoteInclude,
    });
    await recordAudit(tx, {
      quoteId: quote.id,
      userId,
      action: 'create',
      entityTable: 'quotes',
      entityId: quote.id,
    });
    return quote;
  });
};

export const getQuote = async (id: bigint): Promise<QuoteWithChildren> => {
  const quote = await findQuoteById(id);
  if (!quote) throw notFound('Quote', id.toString());
  return quote;
};

/** The acting user, for data scoping. Admins see/act on all quotes; everyone else only their own. */
export interface Actor {
  id: bigint;
  role: UserRole;
}

const isAdmin = (actor: Actor): boolean => actor.role === 'admin';

export const getQuotes = (actor: Actor) =>
  listQuotes(isAdmin(actor) ? undefined : { createdById: actor.id });

/** Throw 404 if the quote is missing, 403 if it isn't the actor's (and they aren't admin). */
export const assertOwnership = async (quoteId: bigint, actor: Actor): Promise<void> => {
  const q = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { id: true, createdById: true },
  });
  if (!q) throw notFound('Quote', quoteId.toString());
  if (!isAdmin(actor) && q.createdById !== actor.id) {
    throw new AppError('forbidden', 'You do not have access to this quote');
  }
};

export const getAuditLog = async (id: bigint) => {
  await getQuote(id);
  return listAuditLog(id);
};

export const updateQuote = async (userId: bigint, id: bigint, input: UpdateQuoteInput) => {
  const existing = await getQuote(id);

  const data: Record<string, unknown> = {};
  if (input.jobReference !== undefined) data.jobReference = input.jobReference;
  if (input.clientId !== undefined) data.clientId = input.clientId;
  if (input.locationId !== undefined) data.locationId = input.locationId;
  if (input.resellerMarkup !== undefined) data.resellerMarkup = input.resellerMarkup;
  if (input.validUntil !== undefined) data.validUntil = input.validUntil;
  if (input.requestedShippingDate !== undefined) data.requestedShippingDate = input.requestedShippingDate;
  if (input.currencyCode !== undefined) {
    const currency = await findCurrencyByCode(input.currencyCode);
    if (!currency) throw notFound('Currency', input.currencyCode);
    data.currencyId = currency.id;
  }

  return prisma.$transaction(async (tx) => {
    const changes = diffFields(
      existing as unknown as Record<string, unknown>,
      data,
      QUOTE_HEADER_FIELDS,
    );
    const quote = await tx.quote.update({
      where: { id },
      data: { ...data, updatedById: userId },
      include: quoteInclude,
    });
    if (changes.length > 0) {
      await recordAudit(tx, {
        quoteId: id,
        userId,
        action: 'update',
        entityTable: 'quotes',
        entityId: id,
        changes,
      });
    }
    return quote;
  });
};

export const changeStatus = async (
  userId: bigint,
  id: bigint,
  status: QuoteStatus,
  reason?: string,
) => {
  const existing = await getQuote(id);
  if (existing.status === status) return existing;

  return prisma.$transaction(async (tx) => {
    const quote = await tx.quote.update({
      where: { id },
      data: { status, updatedById: userId },
      include: quoteInclude,
    });
    await recordAudit(tx, {
      quoteId: id,
      userId,
      action: 'status_change',
      entityTable: 'quotes',
      entityId: id,
      changes: [
        { field: 'status', oldValue: existing.status, newValue: status },
        ...(reason ? [{ field: 'reason', oldValue: null, newValue: reason }] : []),
      ],
    });
    return quote;
  });
};

/** Map a quote's children to calc contributions, then recompute and persist the totals. */
export const recomputeQuote = async (userId: bigint, id: bigint) => {
  const quote = await getQuote(id);
  const lines: QuoteLineContribution[] = [];

  for (const s of quote.ledScreens) {
    lines.push({ kind: 'equipment', extendedSell: dec(s.priceTotal) });
  }
  for (const s of quote.lcdScreens) {
    lines.push({ kind: 'equipment', extendedSell: dec(s.priceTotal) });
  }
  for (const m of quote.manufacturedItems) {
    lines.push({ kind: 'equipment', extendedSell: Number(dec(m.product.sell)) * m.qty });
  }
  for (const a of quote.audioItems) {
    lines.push({ kind: 'equipment', extendedSell: Number(dec(a.audioProduct.sell)) * a.qty });
  }
  for (const sw of quote.softwareItems) {
    lines.push({ kind: 'services', extendedSell: Number(dec(sw.softwareActivity.sell)) * Number(sw.qty) });
  }
  for (const l of quote.licences) {
    lines.push({ kind: 'recurring', extendedSell: Number(dec(l.licenceComponent?.value)) * l.qty });
  }
  for (const mu of quote.musicItems) {
    lines.push({ kind: 'recurring', extendedSell: Number(dec(mu.musicService.sell)) * mu.qty });
  }

  const totals = aggregateQuote(lines, Number(quote.resellerMarkup));

  return prisma.$transaction(async (tx) => {
    const updated = await tx.quote.update({
      where: { id },
      data: {
        totalEquipment: totals.equipment.toString(),
        totalServices: totals.services.toString(),
        totalRecurring: totals.recurring.toString(),
        grandTotal: totals.grandTotal.toString(),
        updatedById: userId,
      },
      include: quoteInclude,
    });
    await recordAudit(tx, {
      quoteId: id,
      userId,
      action: 'update',
      entityTable: 'quotes',
      entityId: id,
      changes: [{ field: 'grand_total', oldValue: dec(quote.grandTotal), newValue: totals.grandTotal.toString() }],
    });
    return updated;
  });
};
