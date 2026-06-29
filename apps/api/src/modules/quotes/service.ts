import { prisma } from '@quotezen/db';
import { aggregateQuote, type QuoteLineContribution } from '@quotezen/calc';
import { marginOf, round, sum } from '@quotezen/shared';
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

  // Optimistic locking (P1-05.2): reject stale writes instead of last-write-wins.
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.lockVersion) {
    throw new AppError(
      'conflict',
      'This quote was changed by someone else. Reload and re-apply your edits.',
      { expectedVersion: input.expectedVersion, currentVersion: existing.lockVersion },
    );
  }

  const data: Record<string, unknown> = { lockVersion: { increment: 1 } };
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

/** Statuses that "finalise" a quote — the margin guardrail is enforced on entry to these. */
const FINALISED_STATUSES: QuoteStatus[] = ['approved', 'issued'];

/** Realised margin from the stored cost/sell breakdown (equipment + services; recurring excluded). */
export const computeMargin = (quote: QuoteWithChildren) => {
  const costs: Array<string> = [];
  const sells: Array<string> = [];
  for (const s of quote.ledScreens) {
    for (const l of s.costBreakdown) {
      if (l.cost) costs.push(l.cost.toString());
      if (l.sell) sells.push(l.sell.toString());
    }
  }
  for (const s of quote.lcdScreens) {
    for (const i of s.items) {
      if (i.unitCost) costs.push(round(Number(i.unitCost) * Number(i.qty)).toString());
      if (i.unitSell) sells.push(round(Number(i.unitSell) * Number(i.qty)).toString());
    }
  }
  const totalCost = sum(costs);
  const totalSell = sum(sells);
  return { totalCost, totalSell, margin: round(marginOf(totalCost, totalSell), 4) };
};

export const getMarginFloor = async (): Promise<number> => {
  const setting = await prisma.setting.findUnique({ where: { key: 'margin_floor' } });
  return setting ? Number(setting.value) : 0;
};

export const changeStatus = async (
  actor: Actor,
  id: bigint,
  status: QuoteStatus,
  reason?: string,
) => {
  const existing = await getQuote(id);
  if (existing.status === status) return existing;

  // Margin guardrail (P1-19g.2): block finalisation below the floor unless the actor is an admin
  // (elevated approval). Admin overrides are allowed but audited.
  let guardrailNote: string | null = null;
  if (FINALISED_STATUSES.includes(status)) {
    const floor = await getMarginFloor();
    const { margin } = computeMargin(existing);
    if (floor > 0 && margin.lessThan(floor)) {
      if (!isAdmin(actor)) {
        throw new AppError(
          'forbidden',
          `Quote margin ${margin.times(100).toFixed(1)}% is below the floor of ${(floor * 100).toFixed(1)}%. Admin approval required.`,
          { margin: margin.toString(), floor },
        );
      }
      guardrailNote = `below-floor override: margin ${margin.times(100).toFixed(1)}% < floor ${(floor * 100).toFixed(1)}%`;
    }
  }

  return prisma.$transaction(async (tx) => {
    const quote = await tx.quote.update({
      where: { id },
      data: { status, updatedById: actor.id, lockVersion: { increment: 1 } },
      include: quoteInclude,
    });
    await recordAudit(tx, {
      quoteId: id,
      userId: actor.id,
      action: 'status_change',
      entityTable: 'quotes',
      entityId: id,
      changes: [
        { field: 'status', oldValue: existing.status, newValue: status },
        ...(reason ? [{ field: 'reason', oldValue: null, newValue: reason }] : []),
        ...(guardrailNote ? [{ field: 'margin_guardrail', oldValue: null, newValue: guardrailNote }] : []),
      ],
    });
    return quote;
  });
};

export interface PriceLine {
  label: string;
  category: string | null;
  qty: number;
  /** Cost is null for non-admin actors (BR-081: sell visible, cost gated). */
  cost: string | null;
  sell: string | null;
}
export interface PriceSection {
  type: 'led' | 'lcd' | 'licence';
  name: string;
  lines: PriceLine[];
  total: string;
}

/**
 * Fully itemised price view (P1-16.8): recompute totals, then return every stored line grouped by
 * screen, with raw cost masked for non-admin actors. Deterministic for a given persisted state.
 */
export const priceQuote = async (actor: Actor, id: bigint) => {
  await recomputeQuote(actor.id, id);
  const quote = await getQuote(id);
  const showCost = isAdmin(actor);

  const sections: PriceSection[] = [];
  for (const s of quote.ledScreens) {
    sections.push({
      type: 'led',
      name: s.screenName ?? 'LED screen',
      total: dec(s.priceTotal),
      lines: s.costBreakdown.map((l) => ({
        label: l.lineLabel,
        category: l.category,
        qty: 1,
        cost: showCost ? dec(l.cost) : null,
        sell: dec(l.sell),
      })),
    });
  }
  for (const s of quote.lcdScreens) {
    sections.push({
      type: 'lcd',
      name: s.screenName ?? 'LCD display',
      total: dec(s.priceTotal),
      lines: s.items.map((i) => ({
        label: i.description ?? i.itemType,
        category: i.itemType,
        qty: Number(i.qty),
        cost: showCost ? dec(i.unitCost) : null,
        sell: dec(i.unitSell),
      })),
    });
  }

  return {
    costVisible: showCost,
    sections,
    licences: quote.licences.map((l) => ({
      screenType: l.screenType,
      tier: l.tier,
      qty: l.qty,
      isInteractive: l.isInteractive,
      annual: dec(l.licenceComponent?.value),
    })),
    totals: {
      equipment: dec(quote.totalEquipment),
      services: dec(quote.totalServices),
      recurring: dec(quote.totalRecurring),
      grandTotal: dec(quote.grandTotal),
      // Margin derives from cost → admin-only (BR-081).
      margin: showCost ? computeMargin(quote).margin.toString() : null,
      marginFloor: showCost ? await getMarginFloor() : null,
    },
  };
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
