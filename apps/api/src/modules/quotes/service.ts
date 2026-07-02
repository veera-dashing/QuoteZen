import { prisma } from '@quotezen/db';
import type { Prisma } from '@quotezen/db';
import { aggregateQuote, type QuoteLineContribution } from '@quotezen/calc';
import { d, marginOf, round, sum } from '@quotezen/shared';
import type { CreateQuoteInput, UpdateQuoteInput } from '@quotezen/shared';
import type { DiscountMode, DiscountScope, QuoteStatus } from '@quotezen/shared';

/** A decimal.js instance (the type `d()` returns); avoids re-exporting the class from shared. */
type Decimal = ReturnType<typeof d>;
import { AppError, conflict, notFound } from '../../errors.js';
import type { UserRole } from '@quotezen/shared';
import { diffFields, recordAudit } from '../../services/audit.js';
import { CAPTURE_STATUSES, captureKbEntry } from './kb.js';
import { assertIssueReviews } from './reviews.js';
import { collectAllErrors, validateQuote } from './validate.js';
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
  'discountPct',
  'discountScope',
  'discountMode',
  'discountNote',
  'siteAddress',
  'projectNotes',
  'endCustomer',
  'airsideLandside',
  'sunExposure',
  'wallSubstrate',
  'powerDataAvailable',
  'controllerLocation',
  'windowFacing',
  'mediaPlayerSupply',
  'sharedDevicePlayers',
  'sharedDeviceScreens',
  'storeSizeSqm',
  'customContentCuration',
  'pcRequired',
  'hardDriveRequired',
] as const;

const dec = (v: { toString(): string } | null | undefined): string => (v ? v.toString() : '0');

// ─── Per-line discounts (V2) ──────────────────────────────────────────────────

type LedScreen = QuoteWithChildren['ledScreens'][number];
type LcdScreen = QuoteWithChildren['lcdScreens'][number];

/** A per-line discount fraction (0..1) or 0 when unset. */
const lineDisc = (v: { toString(): string } | null | undefined): number => (v ? Number(v.toString()) : 0);

/**
 * A LED screen's per-unit effective sell after per-line discounts (V2):
 *   Σ over cost-breakdown lines of line.sell × (1 − (line.discountPct ?? 0)).
 * PRECEDENCE: a pinned C-override (P1-17) wins — if the screen sell is overridden, the override value
 * is the effective sell and per-line discounts on that screen are IGNORED (documented).
 */
const ledScreenDiscountedSell = (overrides: Map<string, OverrideRow>, s: LedScreen): Decimal => {
  const ov = overrides.get(`led_screen_price:${s.id.toString()}`);
  if (ov) return d(ov.overrideValue.toString());
  let total = d(0);
  for (const l of s.costBreakdown) {
    if (l.sell) total = total.plus(d(l.sell.toString()).times(d(1).minus(lineDisc(l.discountPct))));
  }
  return round(total);
};

/**
 * A LCD screen's effective sell that rolls into the quote totals.
 *
 * FAITHFUL TO THE (LCD 1) TAB: the screen's quoted price is the stored **fixed-margin total**
 * (`priceTotal` = ROUND(Σcost / (1 − lcdMargin), −1) = tab G54), NOT the sum of the line list-sells
 * (which are reference and don't reconcile to it). So the rollup starts from `priceTotal`, then scales
 * it by the per-line COST-discount fraction (V2) so per-line discounts still lower the screen price
 * proportionally — with no discount it returns `priceTotal` exactly.
 *   frac = Σ(cost × qty × (1 − disc)) / Σ(cost × qty)   (1 when there are no discounts / no cost)
 *   sell = priceTotal × frac
 * (No screen-level override target for LCD.) This stays SYNC (no settings read): it derives entirely
 * from stored columns, so computeMargin / computeQuoteTotals / priceQuote all stay coherent.
 */
const lcdScreenDiscountedSell = (s: LcdScreen): Decimal => {
  const priceTotal = d(dec(s.priceTotal));
  let fullCost = d(0);
  let discCost = d(0);
  for (const i of s.items) {
    const ext = d(dec(i.unitCost)).times(Number(i.qty));
    fullCost = fullCost.plus(ext);
    discCost = discCost.plus(ext.times(d(1).minus(lineDisc(i.discountPct))));
  }
  const frac = fullCost.greaterThan(0) ? discCost.div(fullCost) : d(1);
  return round(priceTotal.times(frac));
};

/** True when any LED cost line or LCD item on the quote carries a per-line discount (V2). */
const hasLineDiscounts = (quote: QuoteWithChildren): boolean => {
  for (const s of quote.ledScreens) for (const l of s.costBreakdown) if (lineDisc(l.discountPct) > 0) return true;
  for (const s of quote.lcdScreens) for (const i of s.items) if (lineDisc(i.discountPct) > 0) return true;
  return false;
};

/**
 * Resolve the effective quote/client discount for the rollup + margin, honouring the per-quote
 * discount MODE (V2). In `item_only` mode the quote/client discount is SUPPRESSED whenever any
 * per-line discount exists (per-line discounts only); otherwise (`stack`, default) it applies on top
 * of the already-per-line-discounted base. Returns the same shape as `resolveDiscount`.
 */
export const resolveModedDiscount = (quote: QuoteWithChildren, defaultDiscountPct: number): ResolvedDiscount => {
  const resolved = resolveDiscount(quote, defaultDiscountPct);
  const mode = (quote.discountMode as DiscountMode) ?? 'stack';
  if (mode === 'item_only' && hasLineDiscounts(quote)) {
    return { pct: 0, source: resolved.source, scope: resolved.scope };
  }
  return resolved;
};

export const createQuote = async (userId: bigint, input: CreateQuoteInput, actorRole?: UserRole) => {
  if (await findQuoteByJobRef(input.jobReference)) {
    throw conflict(`Job reference "${input.jobReference}" already exists`);
  }
  const currency = await findCurrencyByCode(input.currencyCode);
  if (!currency) throw notFound('Currency', input.currencyCode);

  // Quote-level discount guardrail (A+): 12% cap (admin-overridable) + note required above 5%.
  const { capOverride } = await enforceDiscountGuardrail(
    input.discountPct,
    input.discountNote,
    actorRole === 'admin',
  );

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
        discountPct: input.discountPct ?? null,
        discountScope: input.discountScope ?? 'one_off',
        discountNote: input.discountNote ?? null,
        siteAddress: input.siteAddress ?? null,
        projectNotes: input.projectNotes ?? null,
        endCustomer: input.endCustomer ?? null,
        airsideLandside: input.airsideLandside ?? null,
        sunExposure: input.sunExposure ?? null,
        wallSubstrate: input.wallSubstrate ?? null,
        powerDataAvailable: input.powerDataAvailable ?? null,
        controllerLocation: input.controllerLocation ?? null,
        windowFacing: input.windowFacing ?? null,
        mediaPlayerSupply: input.mediaPlayerSupply ?? null,
        sharedDevicePlayers: input.sharedDevicePlayers ?? null,
        sharedDeviceScreens: input.sharedDeviceScreens ?? null,
        storeSizeSqm: input.storeSizeSqm ?? null,
        customContentCuration: input.customContentCuration ?? null,
        pcRequired: input.pcRequired ?? null,
        hardDriveRequired: input.hardDriveRequired ?? null,
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
      changes: [
        ...(input.viewerUserIds?.length
          ? [{ field: 'viewers', oldValue: null, newValue: input.viewerUserIds.join(',') }]
          : []),
        ...(capOverride ? [{ field: 'discount_guardrail', oldValue: null, newValue: capOverride }] : []),
      ],
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

// ─── Approval tiers (Z3) ──────────────────────────────────────────────────────
// Two-tier margin guardrail: an APPROVER (admin/director/manager) can finalise a quote whose margin
// sits in the "thin" band (walk-away ≤ m < min-gross); only a DIRECTOR-level actor (admin/director)
// can finalise below the walk-away floor.
const APPROVER_ROLES: readonly UserRole[] = ['admin', 'director', 'manager'];
const DIRECTOR_LEVEL_ROLES: readonly UserRole[] = ['admin', 'director'];
/** Manager/Director/Admin — may approve a below-min-gross (but above walk-away) finalisation. */
const isApprover = (actor: Actor): boolean => APPROVER_ROLES.includes(actor.role);
/** Director/Admin — may approve a below-walk-away finalisation (the hard floor). */
const isDirectorLevel = (actor: Actor): boolean => DIRECTOR_LEVEL_ROLES.includes(actor.role);

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

export const updateQuote = async (
  userId: bigint,
  id: bigint,
  input: UpdateQuoteInput,
  actorRole?: UserRole,
) => {
  const existing = await getQuote(id);

  // Optimistic locking (P1-05.2): reject stale writes instead of last-write-wins.
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.lockVersion) {
    throw new AppError(
      'conflict',
      'This quote was changed by someone else. Reload and re-apply your edits.',
      { expectedVersion: input.expectedVersion, currentVersion: existing.lockVersion },
    );
  }

  // Quote-level discount guardrail (A+): evaluate the EFFECTIVE discount + note after this update
  // (fall back to the stored values when a field isn't being changed) so the 12% cap and the
  // above-5% note requirement hold whether the user changes the pct, the note, or both.
  const effectivePct =
    input.discountPct !== undefined ? input.discountPct : existing.discountPct != null ? Number(existing.discountPct) : null;
  const effectiveNote = input.discountNote !== undefined ? input.discountNote : existing.discountNote;
  const { capOverride } = await enforceDiscountGuardrail(effectivePct, effectiveNote, actorRole === 'admin');

  const data: Record<string, unknown> = { lockVersion: { increment: 1 } };
  if (input.jobReference !== undefined) data.jobReference = input.jobReference;
  if (input.clientId !== undefined) data.clientId = input.clientId;
  if (input.locationId !== undefined) data.locationId = input.locationId;
  if (input.resellerMarkup !== undefined) data.resellerMarkup = input.resellerMarkup;
  if (input.validUntil !== undefined) data.validUntil = input.validUntil;
  if (input.requestedShippingDate !== undefined) data.requestedShippingDate = input.requestedShippingDate;
  if (input.discountPct !== undefined) data.discountPct = input.discountPct;
  if (input.discountScope !== undefined) data.discountScope = input.discountScope;
  if (input.discountMode !== undefined) data.discountMode = input.discountMode;
  if (input.discountNote !== undefined) data.discountNote = input.discountNote;
  if (input.siteAddress !== undefined) data.siteAddress = input.siteAddress;
  if (input.projectNotes !== undefined) data.projectNotes = input.projectNotes;
  if (input.endCustomer !== undefined) data.endCustomer = input.endCustomer;
  if (input.airsideLandside !== undefined) data.airsideLandside = input.airsideLandside;
  if (input.sunExposure !== undefined) data.sunExposure = input.sunExposure;
  if (input.wallSubstrate !== undefined) data.wallSubstrate = input.wallSubstrate;
  if (input.powerDataAvailable !== undefined) data.powerDataAvailable = input.powerDataAvailable;
  if (input.controllerLocation !== undefined) data.controllerLocation = input.controllerLocation;
  if (input.windowFacing !== undefined) data.windowFacing = input.windowFacing;
  if (input.mediaPlayerSupply !== undefined) data.mediaPlayerSupply = input.mediaPlayerSupply;
  if (input.sharedDevicePlayers !== undefined) data.sharedDevicePlayers = input.sharedDevicePlayers;
  if (input.sharedDeviceScreens !== undefined) data.sharedDeviceScreens = input.sharedDeviceScreens;
  if (input.storeSizeSqm !== undefined) data.storeSizeSqm = input.storeSizeSqm;
  if (input.customContentCuration !== undefined) data.customContentCuration = input.customContentCuration;
  if (input.pcRequired !== undefined) data.pcRequired = input.pcRequired;
  if (input.hardDriveRequired !== undefined) data.hardDriveRequired = input.hardDriveRequired;
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
    if (capOverride) changes.push({ field: 'discount_guardrail', oldValue: null, newValue: capOverride });
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
 *
 * U3 — the realised margin is computed on the DISCOUNTED sell: the effective client discount reduces
 * the total sell (cost is unchanged), so a discount lowers margin and the existing below-floor
 * guardrail in `changeStatus` fires correctly. `discountPct` is the resolved fraction 0..1.
 *
 * U5 — the realised margin here is the ONE-OFF (equipment + services) margin. Only a `one_off`-scope
 * discount lowers it; a `recurring`-scope discount touches the recurring renewal total, not the
 * upfront sell, so it must NOT reduce this margin (and so must NOT trip the one-off floor guardrail).
 *
 * V2 — per-line discounts: an LED screen's effective sell = Σ(line.sell × (1 − line.discountPct)) and
 * an LCD screen's = Σ(item.unitSell × qty × (1 − item.discountPct)); cost is unchanged. So per-line
 * discounts lower the realised margin (and can trip the below-floor guardrail). Override precedence
 * holds: a pinned screen sell wins and its per-line discounts are ignored. The `discountPct`/`Scope`
 * args here are the resolved quote/client discount (already mode-adjusted by the caller — in
 * `item_only` mode with per-line discounts present, the caller passes pct 0).
 */
export const computeMargin = (
  quote: QuoteWithChildren,
  overrides?: Map<string, OverrideRow>,
  discountPct = 0,
  discountScope: DiscountScope = 'one_off',
) => {
  const ovMap = overrides ?? new Map<string, OverrideRow>();
  const costs: Array<string> = [];
  const sells: Array<string> = [];
  for (const s of quote.ledScreens) {
    const ov = ovMap.get(`led_screen_price:${s.id.toString()}`);
    if (ov) {
      // Pinned sell: override value scaled by screen qty (per-line discounts on this screen ignored).
      sells.push(round(Number(ov.overrideValue.toString()) * s.qty).toString());
      for (const l of s.costBreakdown) if (l.cost) costs.push(l.cost.toString());
      continue;
    }
    // Per-line-discounted per-unit sell × screen qty (V2). Cost stays the undiscounted cost-sum.
    sells.push(round(ledScreenDiscountedSell(ovMap, s).times(s.qty)).toString());
    for (const l of s.costBreakdown) if (l.cost) costs.push(l.cost.toString());
  }
  for (const s of quote.lcdScreens) {
    // Per-line-discounted extended sell (V2). Cost stays undiscounted.
    sells.push(lcdScreenDiscountedSell(s).toString());
    for (const i of s.items) if (i.unitCost) costs.push(round(Number(i.unitCost) * Number(i.qty)).toString());
  }
  const totalCost = sum(costs);
  // U3/U5: a ONE-OFF discount reduces the upfront sell side (cost unchanged) → margin reflects the
  // concession. A recurring-scope discount does not touch the upfront sell, so leave the sell intact.
  const applyDiscount = discountPct > 0 && discountScope === 'one_off';
  const totalSell = applyDiscount ? round(sum(sells).times(d(1).minus(discountPct))) : sum(sells);
  return { totalCost, totalSell, margin: round(marginOf(totalCost, totalSell), 4) };
};

export const getMarginFloor = async (): Promise<number> => {
  const setting = await prisma.setting.findUnique({ where: { key: 'margin_floor' } });
  return setting ? Number(setting.value) : 0;
};

/**
 * Z3 — Minimum gross margin (fraction 0..1, default 0.28). At/above this the finalisation gate is
 * open to any writer. Below it (but ≥ the walk-away floor) an APPROVER (admin/director/manager) is
 * required. This is the surfaced "floor" the UI shows now (replaces `margin_floor` for the gate).
 */
export const getMinGrossMargin = async (): Promise<number> => {
  const setting = await prisma.setting.findUnique({ where: { key: 'min_gross_margin' } });
  return setting ? Number(setting.value) : 0.28;
};

/**
 * Z3 — Walk-away margin (fraction 0..1, default 0.22): the hard floor. Below it, finalisation needs
 * DIRECTOR-level approval (admin/director only — a manager can no longer sign off).
 */
export const getWalkAwayMargin = async (): Promise<number> => {
  const setting = await prisma.setting.findUnique({ where: { key: 'walk_away_margin' } });
  return setting ? Number(setting.value) : 0.22;
};

/** The system default client discount (fraction 0..1), or 0 when unset. */
export const getDefaultDiscountPct = async (): Promise<number> => {
  const setting = await prisma.setting.findUnique({
    where: { key: 'default_client_discount_pct' },
  });
  return setting ? Number(setting.value) : 0;
};

/** Hard cap (fraction 0..1) on the quote-level discount override; non-admins can't exceed it (default 12%). */
export const getDiscountCapPct = async (): Promise<number> => {
  const s = await prisma.setting.findUnique({ where: { key: 'discount_cap_pct' } });
  return s ? Number(s.value) : 0.12;
};

/** Above this discount (fraction 0..1) a manager justification note is required (default 5%). */
export const getDiscountNoteThresholdPct = async (): Promise<number> => {
  const s = await prisma.setting.findUnique({ where: { key: 'discount_note_threshold_pct' } });
  return s ? Number(s.value) : 0.05;
};

/**
 * Quote-level discount guardrail (A+): the discount override is CAPPED at `discount_cap_pct` (default
 * 12%) — a non-admin is blocked above it; an admin may exceed it (allowed, returned as an audit note).
 * Above `discount_note_threshold_pct` (default 5%) a manager justification note is required (any role).
 * `pct` is the effective quote discount override (fraction 0..1) after the update, or null to inherit
 * the client/system default (no guardrail then). Returns a `capOverride` audit string when an admin
 * exceeds the cap, else null. Throws (403 cap / 422 note) when a rule is violated.
 */
const enforceDiscountGuardrail = async (
  pct: number | null | undefined,
  note: string | null | undefined,
  isAdminActor: boolean,
): Promise<{ capOverride: string | null }> => {
  if (pct == null) return { capOverride: null }; // inheriting the client/system default — not gated
  const cap = await getDiscountCapPct();
  const threshold = await getDiscountNoteThresholdPct();
  let capOverride: string | null = null;
  if (pct > cap) {
    if (!isAdminActor) {
      throw new AppError(
        'forbidden',
        `Quote discount ${(pct * 100).toFixed(1)}% exceeds the ${(cap * 100).toFixed(0)}% cap. Admin approval required.`,
        { pct, cap },
      );
    }
    capOverride = `discount cap override: ${(pct * 100).toFixed(1)}% > cap ${(cap * 100).toFixed(0)}%`;
  }
  if (pct > threshold && !note?.trim()) {
    throw new AppError(
      'validation_error',
      `A quote discount above ${(threshold * 100).toFixed(0)}% requires a manager note.`,
      { pct, threshold },
    );
  }
  return { capOverride };
};

/** Where the effective discount came from. */
export type DiscountSource = 'quote' | 'client' | 'tier' | 'system';

export interface ResolvedDiscount {
  /** Fraction 0..1. */
  pct: number;
  source: DiscountSource;
  /** Where the discount applies (U5): one-off upfront concession vs every renewal (recurring). */
  scope: DiscountScope;
}

/**
 * Resolve the effective commercial discount for a quote (U3, extended by Z6 with the tier level). The
 * quote-level override WINS over the client default, which wins over the client's TIER default, which
 * wins over the system default setting. Precedence (global→tier→client, most-specific first):
 *   quote.discountPct → client.discountPct → client.clientTier.defaultDiscountPct
 *     → `default_client_discount_pct` setting → 0.
 * The system-default value must be supplied (read once by the async caller) so this stays pure; the
 * tier value rides along on the loaded `quote.client.clientTier` relation (see repository quoteInclude).
 *
 * U5 — `scope` is always the quote-level decision (`quote.discountScope`, default `one_off`). It is
 * independent of where the *rate* came from: a client/tier/system-default rate still applies to
 * whichever base the quote elected (upfront vs recurring).
 */
export const resolveDiscount = (
  quote: QuoteWithChildren,
  defaultDiscountPct: number,
): ResolvedDiscount => {
  const scope = (quote.discountScope as DiscountScope) ?? 'one_off';
  if (quote.discountPct != null) return { pct: Number(quote.discountPct), source: 'quote', scope };
  if (quote.client?.discountPct != null) {
    return { pct: Number(quote.client.discountPct), source: 'client', scope };
  }
  const tierPct = quote.client?.clientTier?.defaultDiscountPct;
  if (tierPct != null) return { pct: Number(tierPct), source: 'tier', scope };
  if (defaultDiscountPct > 0) return { pct: defaultDiscountPct, source: 'system', scope };
  return { pct: 0, source: 'system', scope };
};

export const changeStatus = async (
  actor: Actor,
  id: bigint,
  status: QuoteStatus,
  reason?: string,
) => {
  const existing = await getQuote(id);
  if (existing.status === status) return existing;

  // BR-001 (T1): no quotation issues without human review and approval. Block the transition to
  // `issued` unless BOTH a technical AND a commercial `approved` review exist for the CURRENT
  // revision (existing.lockVersion — the revision the reviews signed off on, before this issue
  // transition bumps it). Absolute: admins MAY NOT bypass human review (unlike the margin floor).
  if (status === 'issued') {
    await assertIssueReviews(id, existing.lockVersion);
  }

  // Two-tier margin guardrail (Z3): block finalisation by margin band + actor role.
  //   • m ≥ min_gross_margin (28%)                        → OK, no gate.
  //   • walk_away_margin (22%) ≤ m < min_gross_margin     → APPROVER required (admin/director/manager);
  //                                                          otherwise 403. Approver → allowed + audited.
  //   • m < walk_away_margin (22%)                        → DIRECTOR-level required (admin/director only;
  //                                                          manager + sales blocked); director → allowed + audited.
  // Supersedes the single `margin_floor` gate (P1-19g.2). The audit note reuses the `margin_guardrail`
  // change field. Layered with the validation guardrail (below), which is unchanged.
  let guardrailNote: string | null = null;
  // Validation guardrail (P1-15.3 + Z4): block finalisation when any error-severity conflict exists —
  // per-screen validation errors OR anomaly BLOCK findings ('block' → 'error'). A non-APPROVER is
  // blocked; an APPROVER (admin/director/manager, consistent with Z3) may override (audited). Layered
  // alongside the margin guardrail.
  let validationNote: string | null = null;
  if (FINALISED_STATUSES.includes(status)) {
    const [minGross, walkAway] = await Promise.all([getMinGrossMargin(), getWalkAwayMargin()]);
    // Margin must reflect pinned overrides so a below-floor override trips the guardrail (P1-17.5),
    // and the effective client discount (U3) so a deep discount below the floor is gated too.
    const ovMap = overrideMap(await pruneOrphanOverrides(existing, await listOverrides(id)));
    // V2 — mode-adjusted discount so the guardrail fires off the fully-discounted margin (per-line
    // discounts always lower it; the quote discount stacks or is suppressed per discountMode).
    const { pct: discountPct, scope: discountScope } = resolveModedDiscount(
      existing,
      await getDefaultDiscountPct(),
    );
    const { margin } = computeMargin(existing, ovMap, discountPct, discountScope);
    const mPct = margin.times(100).toFixed(1);
    if (margin.lessThan(walkAway)) {
      // Below the walk-away floor: director-level only.
      if (!isDirectorLevel(actor)) {
        throw new AppError(
          'forbidden',
          `Quote margin ${mPct}% is below the ${(walkAway * 100).toFixed(0)}% walk-away floor. Director approval required.`,
          { margin: margin.toString(), walkAwayMargin: walkAway, minGrossMargin: minGross },
        );
      }
      guardrailNote = `walk-away override: margin ${mPct}% < ${(walkAway * 100).toFixed(0)}% (approved by ${actor.role})`;
    } else if (margin.lessThan(minGross)) {
      // Thin band (walk-away ≤ m < min-gross): approver (manager/director/admin).
      if (!isApprover(actor)) {
        throw new AppError(
          'forbidden',
          `Quote margin ${mPct}% is below the minimum gross margin of ${(minGross * 100).toFixed(0)}%. Manager or Director approval required.`,
          { margin: margin.toString(), minGrossMargin: minGross, walkAwayMargin: walkAway },
        );
      }
      guardrailNote = `min-margin override: margin ${mPct}% < ${(minGross * 100).toFixed(0)}% (approved by ${actor.role})`;
    }

    const validation = await validateQuote(id);
    if (!validation.canFinalise) {
      // Z4 — errors now include anomaly BLOCK findings, not just per-screen validation errors.
      const errors = collectAllErrors(validation);
      if (!isApprover(actor)) {
        throw new AppError(
          'conflict',
          `Quote has ${errors.length} unresolved validation error(s): ${errors.map((e) => e.message).join(' ')} Resolve them or request manager/director approval.`,
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
      const { pct, scope } = resolveModedDiscount(quote, await getDefaultDiscountPct());
      await captureKbEntry(tx, quote, actor.id, status, computeMargin(quote, ov, pct, scope).margin.toString());
    }
    return quote;
  });
};

export interface PriceLine {
  /** The stored line id (LED cost-breakdown line / LCD item), so the UI can set/clear its discount. */
  id: string;
  label: string;
  category: string | null;
  qty: number;
  /** Cost is null for non-admin actors (BR-081: sell visible, cost gated). */
  cost: string | null;
  sell: string | null;
  /** Per-line discount fraction 0..1 (V2), or null when none. */
  discountPct: number | null;
  /** The line's effective (post per-line-discount) sell — extended by qty for LCD items (V2). */
  effectiveSell: string;
}
export interface PriceSection {
  type: 'led' | 'lcd' | 'licence';
  name: string;
  /** The screen id this section prices (LED/LCD sections) so the UI can match it to a list row. */
  screenId?: string;
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
  // U3/U5 — effective client discount (quote override → client → system default) + discounted margin.
  // V2 — mode-adjusted: in `item_only` mode with per-line discounts present the quote/client discount
  // is suppressed (pct 0), so the surfaced discount matches what actually applied to the totals.
  const discount = resolveModedDiscount(quote, await getDefaultDiscountPct());
  // Authoritative, scope-aware discount amount (one-off vs recurring) from the shared rollup, so the
  // surfaced concession matches whichever base the discount was applied to (U5).
  const discountAmount = computeQuoteTotals(quote, ovMap, await getDefaultDiscountPct()).discount.amount;

  const sections: PriceSection[] = [];
  for (const s of quote.ledScreens) {
    const eff = effectiveLedScreenSell(ovMap, s.id, dec(s.priceTotal));
    // V2 — the section total is the EFFECTIVE per-unit sell that rolls into the totals: an active
    // override pins it (per-line discounts ignored), else it's the per-line-discounted sell.
    sections.push({
      type: 'led',
      name: s.screenName ?? 'LED screen',
      screenId: s.id.toString(),
      total: eff.overridden ? eff.value : ledScreenDiscountedSell(ovMap, s).toString(),
      overridden: eff.overridden,
      targetId: s.id.toString(),
      computedTotal: dec(s.priceTotal),
      lines: s.costBreakdown.map((l) => {
        const disc = lineDisc(l.discountPct);
        return {
          id: l.id.toString(),
          label: l.lineLabel,
          category: l.category,
          qty: 1,
          cost: showCost ? dec(l.cost) : null,
          sell: dec(l.sell),
          discountPct: l.discountPct != null ? disc : null,
          effectiveSell: round(d(dec(l.sell)).times(d(1).minus(disc))).toString(),
        };
      }),
    });
  }
  for (const s of quote.lcdScreens) {
    sections.push({
      type: 'lcd',
      name: s.screenName ?? 'LCD display',
      screenId: s.id.toString(),
      // V2 — effective sell after per-line discounts (what rolls into totals).
      total: lcdScreenDiscountedSell(s).toString(),
      computedTotal: dec(s.priceTotal),
      lines: s.items.map((i) => {
        const disc = lineDisc(i.discountPct);
        const extendedSell = d(dec(i.unitSell)).times(Number(i.qty));
        return {
          id: i.id.toString(),
          label: i.description ?? i.itemType,
          category: i.itemType,
          qty: Number(i.qty),
          cost: showCost ? dec(i.unitCost) : null,
          sell: dec(i.unitSell),
          discountPct: i.discountPct != null ? disc : null,
          effectiveSell: round(extendedSell.times(d(1).minus(disc))).toString(),
        };
      }),
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
    // U3/U5 — effective discount; `scope` decides the base: `one_off` discounts the upfront sell
    // (equipment + services, after markup), `recurring` discounts the renewal total. `amount` is the
    // dollar concession on whichever base, taken from the shared scope-aware rollup.
    // V2 — the per-quote discount mode + whether any per-line discount exists (so the UI can explain
    // why the quote/client discount is or isn't applied in `item_only` mode).
    discountMode: (quote.discountMode as DiscountMode) ?? 'stack',
    hasLineDiscounts: hasLineDiscounts(quote),
    discount: {
      pct: discount.pct,
      source: discount.source,
      scope: discount.scope,
      amount: discountAmount,
    },
    totals: {
      equipment: dec(quote.totalEquipment),
      services: dec(quote.totalServices),
      recurring: dec(quote.totalRecurring),
      grandTotal: dec(quote.grandTotal),
      // Margin derives from cost → admin-only (BR-081); reflects pinned overrides (P1-17.5) and the
      // effective client discount (U3 — discount lowers the realised margin).
      margin: showCost ? computeMargin(quote, ovMap, discount.pct, discount.scope).margin.toString() : null,
      // Z3 — the surfaced "floor" is now the minimum gross margin (the 28% gate the UI enforces first);
      // the walk-away floor is the harder director-only tier below it.
      marginFloor: showCost ? await getMinGrossMargin() : null,
      walkAwayMargin: showCost ? await getWalkAwayMargin() : null,
    },
  };
};

export interface QuoteTotalsResult {
  equipment: string;
  services: string;
  recurring: string;
  grandTotal: string;
  /** The effective client discount applied (U3/U5). */
  discount: { pct: number; source: DiscountSource; scope: DiscountScope; amount: string };
}

/**
 * Pure rollup: map a quote's children to calc contributions and aggregate them, applying any pinned
 * overrides. No DB writes — shared by the persisting `recomputeQuote` and the read-only
 * `recomputePreview` (P1-19d.3) so the two can never drift.
 *
 * U3 — client discount: the effective discount (quote override → client → system default) reduces the
 * SELL price. It applies ONLY to the one-off sell base (equipment + services) — recurring licences,
 * music and other annual lines are EXCLUDED by decision (a discount is a one-off concession, not an
 * ongoing rate cut). The reseller markup is applied first (it's part of the "sell"), then the discount
 * comes off that grossed-up upfront total, then recurring is added back:
 *   grandTotal = (equipment + services) − discountAmount + recurring.
 * Money stays Decimal throughout (no float).
 */
export const computeQuoteTotals = (
  quote: QuoteWithChildren,
  overrides: Map<string, OverrideRow>,
  defaultDiscountPct = 0,
): QuoteTotalsResult => {
  const lines: QuoteLineContribution[] = [];

  // Per-screen qty multiplies the stored (per-unit) price into the rollup (P1-14.2). LED screens
  // carry a screen-level qty; LCD screens have none (their item rows carry their own qty), so the
  // stored LCD priceTotal is already the full screen price.
  for (const s of quote.ledScreens) {
    // V2 — per-line-discounted per-unit sell (override pin wins), × screen qty.
    lines.push({ kind: 'equipment', extendedSell: round(ledScreenDiscountedSell(overrides, s).times(s.qty)).toString() });
  }
  for (const s of quote.lcdScreens) {
    // V2 — per-line-discounted extended sell (Σ item.unitSell × qty × (1 − discountPct)).
    lines.push({ kind: 'equipment', extendedSell: lcdScreenDiscountedSell(s).toString() });
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

  const agg = aggregateQuote(lines, Number(quote.resellerMarkup));

  // U3/U5 — apply the effective client discount to the base the quote elected (`discountScope`).
  // `agg.grandTotal` is the upfront (equipment + services) after the reseller markup; `agg.recurring`
  // is the annual/renewal total. Decimal math throughout.
  //   • one_off  (default): discount the UPFRONT base; recurring untouched. Matches U3 behaviour.
  //   • recurring         : discount the RECURRING total; upfront untouched.
  // V2 — the quote/client discount is mode-adjusted: in `item_only` mode it is suppressed (pct 0)
  // whenever any per-line discount exists, so per-line discounts don't stack with the quote discount.
  const { pct, source, scope } = resolveModedDiscount(quote, defaultDiscountPct);
  const recurringBase = round(agg.recurring);
  let recurring = recurringBase;
  let upfront = round(agg.grandTotal);
  let discountAmount = round(0);
  if (pct > 0) {
    if (scope === 'recurring') {
      discountAmount = round(recurringBase.times(pct));
      recurring = round(recurringBase.minus(discountAmount));
    } else {
      discountAmount = round(agg.grandTotal.times(pct));
      upfront = round(agg.grandTotal.minus(discountAmount));
    }
  }
  // grandTotal is the upfront one-off total (recurring is reported separately, as before).
  const grandTotal = upfront;

  return {
    equipment: agg.equipment.toString(),
    services: agg.services.toString(),
    recurring: recurring.toString(),
    grandTotal: grandTotal.toString(),
    discount: { pct, source, scope, amount: discountAmount.toString() },
  };
};

/**
 * Recompute-preview (P1-19d.3): re-run the rollup in memory and compare to the stored grand total —
 * WITHOUT persisting anything. Lets a "reopened" finished quote surface "recomputing now would change
 * X → Y" vs "keep as quoted". Shares `computeQuoteTotals` with the real recompute so they can't drift.
 */
export const recomputePreview = async (id: bigint) => {
  const quote = await getQuote(id);
  const overrides = overrideMap(await pruneOrphanOverrides(quote, await listOverrides(id)));
  const defaultDiscount = await getDefaultDiscountPct();
  const recomputed = computeQuoteTotals(quote, overrides, defaultDiscount).grandTotal;
  const current = dec(quote.grandTotal);
  return { current, recomputed, differs: Number(current) !== Number(recomputed) };
};

/** Resolve the effective discount for a quote by id (reads the system default). */
export const getEffectiveDiscount = async (id: bigint): Promise<ResolvedDiscount> => {
  const quote = await getQuote(id);
  return resolveDiscount(quote, await getDefaultDiscountPct());
};

/** Map a quote's children to calc contributions, then recompute and persist the totals. */
export const recomputeQuote = async (userId: bigint, id: bigint) => {
  const quote = await getQuote(id);
  // Pinned overrides (P1-17): a screen's effective sell is its override value (if active) else the
  // computed price; everything downstream (equipment, grand total) recomputes from the pinned value.
  const overrides = overrideMap(await pruneOrphanOverrides(quote, await listOverrides(id)));
  const defaultDiscount = await getDefaultDiscountPct();
  const totals = computeQuoteTotals(quote, overrides, defaultDiscount);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.quote.update({
      where: { id },
      data: {
        totalEquipment: totals.equipment,
        totalServices: totals.services,
        totalRecurring: totals.recurring,
        grandTotal: totals.grandTotal,
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
      changes: [{ field: 'grand_total', oldValue: dec(quote.grandTotal), newValue: totals.grandTotal }],
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
    const { pct, scope } = resolveModedDiscount(updated, await getDefaultDiscountPct());
    const { margin } = computeMargin(updated, ovMap, pct, scope);
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

// ─── Per-line discounts (V2) ──────────────────────────────────────────────────

/**
 * Set (or clear, when `discountPct` is null) a per-line discount on a LED cost-breakdown line
 * (V2). The line must belong to a screen on this quote. Audits the change and recomputes so the
 * discounted sell flows into the totals + margin. Returns the recomputed quote.
 */
export const setLedLineDiscount = async (
  actor: Actor,
  quoteId: bigint,
  lineId: bigint,
  discountPct: number | null,
): Promise<QuoteWithChildren> => {
  const line = await prisma.quoteLedCostBreakdown.findUnique({
    where: { id: lineId },
    include: { screen: { select: { quoteId: true } } },
  });
  if (!line || line.screen.quoteId !== quoteId) throw notFound('LED cost line', lineId.toString());

  const oldPct = line.discountPct != null ? line.discountPct.toString() : null;
  await prisma.$transaction(async (tx) => {
    await tx.quoteLedCostBreakdown.update({ where: { id: lineId }, data: { discountPct } });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'update',
      entityTable: 'quote_led_cost_breakdown',
      entityId: lineId,
      changes: [{ field: 'discount_pct', oldValue: oldPct, newValue: discountPct }],
    });
  });

  await recomputeQuote(actor.id, quoteId);
  return getQuote(quoteId);
};

/**
 * Set (or clear) a per-line discount on a LCD item line (V2). The item must belong to a screen on
 * this quote. Audits + recomputes. Returns the recomputed quote.
 */
export const setLcdItemDiscount = async (
  actor: Actor,
  quoteId: bigint,
  itemId: bigint,
  discountPct: number | null,
): Promise<QuoteWithChildren> => {
  const item = await prisma.quoteLcdItem.findUnique({
    where: { id: itemId },
    include: { screen: { select: { quoteId: true } } },
  });
  if (!item || item.screen.quoteId !== quoteId) throw notFound('LCD item', itemId.toString());

  const oldPct = item.discountPct != null ? item.discountPct.toString() : null;
  await prisma.$transaction(async (tx) => {
    await tx.quoteLcdItem.update({ where: { id: itemId }, data: { discountPct } });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'update',
      entityTable: 'quote_lcd_items',
      entityId: itemId,
      changes: [{ field: 'discount_pct', oldValue: oldPct, newValue: discountPct }],
    });
  });

  await recomputeQuote(actor.id, quoteId);
  return getQuote(quoteId);
};
