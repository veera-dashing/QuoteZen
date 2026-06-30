import { prisma } from '@quotezen/db';
import type { Prisma } from '@quotezen/db';
import { aggregateQuote, type QuoteLineContribution } from '@quotezen/calc';
import { marginOf, round, sum } from '@quotezen/shared';
import type { CreateQuoteInput, UpdateQuoteInput } from '@quotezen/shared';
import type { QuoteStatus } from '@quotezen/shared';
import { AppError, conflict, notFound } from '../../errors.js';
import type { UserRole } from '@quotezen/shared';
import { diffFields, recordAudit } from '../../services/audit.js';
import { CAPTURE_STATUSES, captureKbEntry } from './kb.js';
import { collectScreenErrors, validateQuote } from './validate.js';
import {
  findCurrencyByCode,
  findQuoteById,
  findQuoteByJobRef,
  listAllAuditLog,
  listAuditLog,
  listQuotes,
  quoteInclude,
  type AuditFilters,
  type QuoteWithChildren,
} from './repository.js';
import type { SetOverrideInput } from '@quotezen/shared';
import {
  effectiveLedScreenSell,
  listOverrides,
  overrideMap,
  pruneOrphanOverrides,
  type OverrideRow,
} from './overrides.js';

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
        viewers: input.viewerUserIds?.length
          ? { create: input.viewerUserIds.map((uid) => ({ userId: BigInt(uid) })) }
          : undefined,
      },
      include: quoteInclude,
    });
    await recordAudit(tx, {
      quoteId: quote.id,
      userId,
      action: 'create',
      entityTable: 'quotes',
      entityId: quote.id,
      changes: input.viewerUserIds?.length
        ? [{ field: 'viewers', oldValue: null, newValue: input.viewerUserIds.join(',') }]
        : undefined,
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

export interface ListQuotesOptions {
  /** Show archived quotes instead of active ones (P1-05.1). Defaults to active-only. */
  archived?: boolean;
  /** Dashboard filters (P1-19d.1), composed alongside the per-user scope + archive filter. */
  status?: QuoteStatus;
  clientId?: number;
  /** Case-insensitive substring match on jobReference. */
  q?: string;
  /** createdAt date range (inclusive). */
  from?: Date;
  to?: Date;
}

/**
 * List quotes the actor may see (admins → all; others → own + assigned-as-viewer), composed with the
 * archive filter and the optional dashboard filters (status / client / jobRef substring / createdAt
 * range, P1-19d.1). The per-user scope and archive default (active-only) are always applied; filters
 * only narrow further, so existing callers passing no filters behave exactly as before.
 */
export const getQuotes = (actor: Actor, opts: ListQuotesOptions = {}) => {
  const clauses: Prisma.QuoteWhereInput[] = [
    opts.archived ? { NOT: { archivedAt: null } } : { archivedAt: null },
  ];
  if (!isAdmin(actor)) {
    clauses.push({ OR: [{ createdById: actor.id }, { viewers: { some: { userId: actor.id } } }] });
  }
  if (opts.status) clauses.push({ status: opts.status });
  if (opts.clientId !== undefined) clauses.push({ clientId: opts.clientId });
  if (opts.q) clauses.push({ jobReference: { contains: opts.q, mode: 'insensitive' } });
  if (opts.from || opts.to) {
    clauses.push({ createdAt: { gte: opts.from, lte: opts.to } });
  }
  return listQuotes({ AND: clauses });
};

/** Archive (soft-delete) a quote: stamp archivedAt, audit, never hard-delete (P1-05.1). */
export const archiveQuote = async (userId: bigint, id: bigint) => {
  const existing = await getQuote(id);
  if (existing.archivedAt) return existing;
  return prisma.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id },
      data: { archivedAt: new Date(), updatedById: userId, lockVersion: { increment: 1 } },
    });
    await recordAudit(tx, {
      quoteId: id,
      userId,
      action: 'update',
      entityTable: 'quotes',
      entityId: id,
      changes: [{ field: 'archived', oldValue: 'false', newValue: 'true' }],
    });
    return tx.quote.findUniqueOrThrow({ where: { id }, include: quoteInclude });
  });
};

/** Restore an archived quote: clear archivedAt, audit (P1-05.1). */
export const restoreQuote = async (userId: bigint, id: bigint) => {
  const existing = await getQuote(id);
  if (!existing.archivedAt) return existing;
  return prisma.$transaction(async (tx) => {
    await tx.quote.update({
      where: { id },
      data: { archivedAt: null, updatedById: userId, lockVersion: { increment: 1 } },
    });
    await recordAudit(tx, {
      quoteId: id,
      userId,
      action: 'update',
      entityTable: 'quotes',
      entityId: id,
      changes: [{ field: 'archived', oldValue: 'true', newValue: 'false' }],
    });
    return tx.quote.findUniqueOrThrow({ where: { id }, include: quoteInclude });
  });
};

/** Cross-quote audit feed (admin only — enforced at the route via requireRole). */
export const getAllAuditLog = (filters?: AuditFilters) => listAllAuditLog(filters);

/**
 * Throw 404 if the quote is missing, 403 if the actor can't access it. Access = admin, the creator,
 * or a viewer the quote has been shared with.
 */
export const assertOwnership = async (quoteId: bigint, actor: Actor): Promise<void> => {
  const q = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { id: true, createdById: true, viewers: { where: { userId: actor.id }, select: { id: true } } },
  });
  if (!q) throw notFound('Quote', quoteId.toString());
  const assigned = q.viewers.length > 0;
  if (!isAdmin(actor) && q.createdById !== actor.id && !assigned) {
    throw new AppError('forbidden', 'You do not have access to this quote');
  }
};

export const getAuditLog = async (id: bigint, filters?: AuditFilters) => {
  await getQuote(id);
  return listAuditLog(id, filters);
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
    await tx.quote.update({ where: { id }, data: { ...data, updatedById: userId } });
    // Replace viewer assignments when provided.
    if (input.viewerUserIds !== undefined) {
      await tx.quoteViewer.deleteMany({ where: { quoteId: id } });
      if (input.viewerUserIds.length) {
        await tx.quoteViewer.createMany({
          data: input.viewerUserIds.map((uid) => ({ quoteId: id, userId: BigInt(uid) })),
        });
      }
      changes.push({ field: 'viewers', oldValue: null, newValue: input.viewerUserIds.join(',') });
    }
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
    return tx.quote.findUniqueOrThrow({ where: { id }, include: quoteInclude });
  });
};

/** Statuses that "finalise" a quote — the margin guardrail is enforced on entry to these. */
const FINALISED_STATUSES: QuoteStatus[] = ['approved', 'issued'];

/**
 * Realised margin from the stored cost/sell breakdown (equipment + services; recurring excluded).
 * When `overrides` is supplied, an overridden LED screen's SELL contribution = its override value
 * (× qty) — cost stays the computed cost-sum — so margin reflects overrides and the existing
 * below-floor finalisation guardrail (P1-19g.2) triggers automatically (P1-17.5).
 */
export const computeMargin = (
  quote: QuoteWithChildren,
  overrides?: Map<string, OverrideRow>,
) => {
  const costs: Array<string> = [];
  const sells: Array<string> = [];
  for (const s of quote.ledScreens) {
    const ov = overrides?.get(`led_screen_price:${s.id.toString()}`);
    if (ov) {
      // Pinned sell: override value scaled by screen qty. Cost still rolls up from the breakdown.
      sells.push(round(Number(ov.overrideValue.toString()) * s.qty).toString());
      for (const l of s.costBreakdown) if (l.cost) costs.push(l.cost.toString());
      continue;
    }
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
  // Validation guardrail (P1-15.3): block finalisation when any error-severity conflict exists,
  // unless the actor is an admin (override, audited). Layered alongside the margin guardrail.
  let validationNote: string | null = null;
  if (FINALISED_STATUSES.includes(status)) {
    const floor = await getMarginFloor();
    // Margin must reflect pinned overrides so a below-floor override trips the guardrail (P1-17.5).
    const ovMap = overrideMap(await pruneOrphanOverrides(existing, await listOverrides(id)));
    const { margin } = computeMargin(existing, ovMap);
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

    const validation = await validateQuote(id);
    if (!validation.canFinalise) {
      const errors = collectScreenErrors(validation);
      if (!isAdmin(actor)) {
        throw new AppError(
          'conflict',
          `Quote has ${errors.length} unresolved validation error(s): ${errors.map((e) => e.message).join(' ')} Resolve them or request admin approval.`,
          { errors: errors.map((e) => ({ rule: e.rule, message: e.message })) },
        );
      }
      validationNote = `validation override: ${errors.map((e) => e.rule).join(', ')}`;
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
        ...(validationNote ? [{ field: 'validation_guardrail', oldValue: null, newValue: validationNote }] : []),
      ],
    });
    // Knowledge-base capture on outcome states (P1-19f). Margin reflects pinned overrides.
    if (CAPTURE_STATUSES.includes(status)) {
      const ov = overrideMap(await listOverrides(id));
      await captureKbEntry(tx, quote, actor.id, status, computeMargin(quote, ov).margin.toString());
    }
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
  /** Effective (pinned) total — the value that rolls into the quote totals. */
  total: string;
  /** True when an active manual override is pinning this section's price (P1-17.2). */
  overridden?: boolean;
  /** The screen/target id (LED only) so the UI can set/clear the override. */
  targetId?: string;
  /** The computed price before any override — shown alongside the pinned value. */
  computedTotal?: string;
}

/** A flagged active override surfaced to the client (P1-17.2/.3). */
export interface OverrideSummary {
  id: string;
  targetType: string;
  targetId: string | null;
  fieldName: string;
  originalValue: string;
  overrideValue: string;
  reason: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

/**
 * Fully itemised price view (P1-16.8): recompute totals, then return every stored line grouped by
 * screen, with raw cost masked for non-admin actors. Deterministic for a given persisted state.
 */
export const priceQuote = async (actor: Actor, id: bigint) => {
  await recomputeQuote(actor.id, id);
  const quote = await getQuote(id);
  const showCost = isAdmin(actor);
  // Active overrides (post-prune) drive the per-line flag + the overrides summary (P1-17.2/.3).
  const activeOverrides = await pruneOrphanOverrides(quote, await listOverrides(id));
  const ovMap = overrideMap(activeOverrides);

  const sections: PriceSection[] = [];
  for (const s of quote.ledScreens) {
    const eff = effectiveLedScreenSell(ovMap, s.id, dec(s.priceTotal));
    sections.push({
      type: 'led',
      name: s.screenName ?? 'LED screen',
      // The section total is the effective (pinned) sell — what actually rolls into the totals.
      total: eff.value,
      overridden: eff.overridden,
      targetId: s.id.toString(),
      computedTotal: dec(s.priceTotal),
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

  const overridesOut: OverrideSummary[] = activeOverrides.map((o) => ({
    id: o.id.toString(),
    targetType: o.targetType,
    targetId: o.targetId?.toString() ?? null,
    fieldName: o.fieldName,
    originalValue: o.originalValue.toString(),
    overrideValue: o.overrideValue.toString(),
    reason: o.reason,
    createdBy: o.createdBy ? { id: o.createdBy.id.toString(), name: o.createdBy.name } : null,
    createdAt: o.createdAt.toISOString(),
  }));

  return {
    costVisible: showCost,
    sections,
    // Active overrides + a convenience flag so the UI can badge affected lines/totals (P1-17.2).
    overrides: overridesOut,
    hasOverrides: overridesOut.length > 0,
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
      // Margin derives from cost → admin-only (BR-081); reflects pinned overrides (P1-17.5).
      margin: showCost ? computeMargin(quote, ovMap).margin.toString() : null,
      marginFloor: showCost ? await getMarginFloor() : null,
    },
  };
};

/**
 * Pure rollup: map a quote's children to calc contributions and aggregate them, applying any pinned
 * overrides. No DB writes — shared by the persisting `recomputeQuote` and the read-only
 * `recomputePreview` (P1-19d.3) so the two can never drift.
 */
export const computeQuoteTotals = (
  quote: QuoteWithChildren,
  overrides: Map<string, OverrideRow>,
) => {
  const lines: QuoteLineContribution[] = [];

  // Per-screen qty multiplies the stored (per-unit) price into the rollup (P1-14.2). LED screens
  // carry a screen-level qty; LCD screens have none (their item rows carry their own qty), so the
  // stored LCD priceTotal is already the full screen price.
  for (const s of quote.ledScreens) {
    const sell = effectiveLedScreenSell(overrides, s.id, dec(s.priceTotal)).value;
    lines.push({ kind: 'equipment', extendedSell: round(Number(sell) * s.qty) });
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

  return aggregateQuote(lines, Number(quote.resellerMarkup));
};

/**
 * Recompute-preview (P1-19d.3): re-run the rollup in memory and compare to the stored grand total —
 * WITHOUT persisting anything. Lets a "reopened" finished quote surface "recomputing now would change
 * X → Y" vs "keep as quoted". Shares `computeQuoteTotals` with the real recompute so they can't drift.
 */
export const recomputePreview = async (id: bigint) => {
  const quote = await getQuote(id);
  const overrides = overrideMap(await pruneOrphanOverrides(quote, await listOverrides(id)));
  const recomputed = computeQuoteTotals(quote, overrides).grandTotal.toString();
  const current = dec(quote.grandTotal);
  return { current, recomputed, differs: Number(current) !== Number(recomputed) };
};

/** Map a quote's children to calc contributions, then recompute and persist the totals. */
export const recomputeQuote = async (userId: bigint, id: bigint) => {
  const quote = await getQuote(id);
  // Pinned overrides (P1-17): a screen's effective sell is its override value (if active) else the
  // computed price; everything downstream (equipment, grand total) recomputes from the pinned value.
  const overrides = overrideMap(await pruneOrphanOverrides(quote, await listOverrides(id)));
  const totals = computeQuoteTotals(quote, overrides);

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

// ─── Manual price overrides (P1-17) ───────────────────────────────────────────

export interface OverrideResult {
  override: OverrideSummary;
  /** Set when the override lowers margin below the floor — allowed, but surfaced as a warning (.4). */
  warning: string | null;
  quote: QuoteWithChildren;
}

const toSummary = (o: OverrideRow): OverrideSummary => ({
  id: o.id.toString(),
  targetType: o.targetType,
  targetId: o.targetId?.toString() ?? null,
  fieldName: o.fieldName,
  originalValue: o.originalValue.toString(),
  overrideValue: o.overrideValue.toString(),
  reason: o.reason,
  createdBy: o.createdBy ? { id: o.createdBy.id.toString(), name: o.createdBy.name } : null,
  createdAt: o.createdAt.toISOString(),
});

/**
 * Pin a manual override on a computed field (P1-17.1/.2). Captures the CURRENT computed value as
 * `originalValue`, upserts the override (one active per field), audits it, then recomputes so every
 * downstream total reflects the pinned value. Returns a warning when the override drops margin below
 * the floor (.4) — allowed (a judgement call) but flagged.
 */
export const setOverride = async (
  actor: Actor,
  quoteId: bigint,
  input: SetOverrideInput,
): Promise<OverrideResult> => {
  const quote = await getQuote(quoteId);

  // Resolve the target's current computed value (the value being pinned over).
  let computed: string;
  if (input.targetType === 'led_screen_price') {
    const screen = quote.ledScreens.find((s) => s.id === input.targetId);
    if (!screen) throw notFound('LED screen', input.targetId.toString());
    computed = dec(screen.priceTotal);
  } else {
    throw new AppError('bad_request', `Unsupported override target "${input.targetType}"`);
  }

  const value = round(input.value).toString();
  const fieldName = 'price_total';
  const auditField = `override:${input.targetType}:${input.targetId.toString()}`;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.quoteOverride.findUnique({
      where: {
        quoteId_targetType_targetId_fieldName: {
          quoteId,
          targetType: input.targetType,
          targetId: input.targetId,
          fieldName,
        },
      },
    });
    const saved = await tx.quoteOverride.upsert({
      where: {
        quoteId_targetType_targetId_fieldName: {
          quoteId,
          targetType: input.targetType,
          targetId: input.targetId,
          fieldName,
        },
      },
      create: {
        quoteId,
        targetType: input.targetType,
        targetId: input.targetId,
        fieldName,
        originalValue: computed,
        overrideValue: value,
        reason: input.reason ?? null,
        createdById: actor.id,
      },
      // Re-setting keeps the FIRST computed value as the original (the true baseline), only the value/reason change.
      update: { overrideValue: value, reason: input.reason ?? null, createdById: actor.id },
    });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'update',
      entityTable: 'quote_overrides',
      entityId: saved.id,
      changes: [
        {
          field: auditField,
          oldValue: existing ? existing.overrideValue.toString() : computed,
          newValue: value,
        },
        ...(input.reason ? [{ field: `${auditField}:reason`, oldValue: null, newValue: input.reason }] : []),
      ],
    });
  });

  // Recompute downstream from the pinned value, then re-read with the override applied.
  await recomputeQuote(actor.id, quoteId);
  const updated = await getQuote(quoteId);
  const ovMap = overrideMap(await listOverrides(quoteId));
  const saved = ovMap.get(`${input.targetType}:${input.targetId.toString()}`);

  // Margin warning (.4): allowed below floor, but flagged.
  let warning: string | null = null;
  const floor = await getMarginFloor();
  if (floor > 0) {
    const { margin } = computeMargin(updated, ovMap);
    if (margin.lessThan(floor)) {
      warning = `This override drops the quote margin to ${margin.times(100).toFixed(1)}%, below the floor of ${(floor * 100).toFixed(1)}%. Finalisation will require admin approval.`;
    }
  }

  return { override: toSummary(saved as OverrideRow), warning, quote: updated };
};

/** Clear an override (P1-17.1): delete + audit + recompute so totals revert to the computed value. */
export const clearOverride = async (
  actor: Actor,
  quoteId: bigint,
  overrideId: bigint,
): Promise<QuoteWithChildren> => {
  const existing = await prisma.quoteOverride.findFirst({ where: { id: overrideId, quoteId } });
  if (!existing) throw notFound('Override', overrideId.toString());

  await prisma.$transaction(async (tx) => {
    await tx.quoteOverride.delete({ where: { id: overrideId } });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'delete',
      entityTable: 'quote_overrides',
      entityId: overrideId,
      changes: [
        {
          field: `override:${existing.targetType}:${existing.targetId?.toString() ?? ''}`,
          oldValue: existing.overrideValue.toString(),
          newValue: existing.originalValue.toString(),
        },
      ],
    });
  });

  await recomputeQuote(actor.id, quoteId);
  return getQuote(quoteId);
};

/** List a quote's active overrides (auto-pruning orphans). */
export const getOverrides = async (quoteId: bigint): Promise<OverrideSummary[]> => {
  const quote = await getQuote(quoteId);
  const active = await pruneOrphanOverrides(quote, await listOverrides(quoteId));
  return active.map(toSummary);
};
