import { prisma } from '@quotezen/db';
import type { Prisma } from '@quotezen/db';
import type { PricingConfig } from '@quotezen/calc';
import type { DiscountScope } from '@quotezen/shared';
import { recordAudit } from '../../services/audit.js';
import {
  getQuote,
  getMarginFloor,
  getMinGrossMargin,
  getWalkAwayMargin,
  getDiscountCapPct,
  getDiscountNoteThresholdPct,
  getDefaultDiscountPct,
  resolveDiscount,
  recomputeQuote,
  type Actor,
  type DiscountSource,
} from './service.js';
import { loadPricingConfig } from '../../lib/pricing-config.js';
import type { QuoteWithChildren } from './repository.js';

/**
 * Versioning & snapshots (P1-04). A version is an immutable JSON snapshot of the full quote (header +
 * screens + components + computed outputs) at save time. Rollback restores a prior snapshot as a NEW
 * version — history is never destroyed.
 *
 * P1-04.1: the snapshot also embeds the **rule-set in force** at capture time (markups, freight, add-on
 * and FX rates + the margin floor) under a top-level `ruleSet` key, so editing a margin/FX rate later
 * can never silently change what a saved version represents. It is a sibling of the quote-tree keys —
 * rollback ignores it (it only restores the screen tree); diff naturally surfaces `ruleSet.*` changes.
 */

/** The resolved effective discount for the quote, as of capture time (mirrors `/price`). */
export interface SnapshotDiscount {
  /** Fraction 0..1. */
  pct: number;
  source: DiscountSource;
  scope: DiscountScope;
}

/** The client's tier (Z6) as of capture time, or null when the quote has no client/tier. */
export interface SnapshotClientTier {
  name: string;
  preferredFreight: string | null;
  defaultDiscountPct: number | null;
}

/** One anomaly rule (Z4) row, snapshotted so a later toggle can't rewrite history. */
export interface SnapshotAnomalyRule {
  key: string;
  label: string;
  enabled: boolean;
  severity: string;
  paramNum: number | null;
}

/** The Z1 financial bumpers (non-margin/discount) as of capture time. */
export interface SnapshotFinancialBumpers {
  leadTimeBufferDays: number | null;
  audUsdRate: number | null;
  humanInTheLoop: number | null;
}

/** A manufacturer's governance priority (compact — per-product priorities are NOT captured). */
export interface SnapshotManufacturerPriority {
  name: string;
  priority: number;
}

/**
 * The full governance rule-set in force when a version was captured, embedded immutably into the
 * snapshot so a later edit to any setting/rule can never silently change what a saved version means.
 * The existing pricing fields (markups/freight/addOns/rates/marginFloor/capturedAt) are unchanged;
 * the rest capture the margin bands, discount policy + the quote's resolved effective discount, the
 * client tier, the anomaly-rule table, the financial bumpers, and manufacturer priorities.
 */
export interface SnapshotRuleSet {
  markups: PricingConfig['markups'];
  freight: PricingConfig['freight'];
  addOns: PricingConfig['addOns'];
  rates: PricingConfig['rates'];
  marginFloor: number;
  /** Z3 margin bands (fraction 0..1). */
  minGrossMargin: number;
  walkAwayMargin: number;
  /** Quote-discount policy (fraction 0..1). */
  discountCapPct: number;
  discountNoteThresholdPct: number;
  /** The effective discount resolved for THIS quote (as `/price` does). */
  discount: SnapshotDiscount;
  /** The quote's client tier (Z6), or null. */
  clientTier: SnapshotClientTier | null;
  /** ALL anomaly-rule rows (Z4), enabled or not. */
  anomalyRules: SnapshotAnomalyRule[];
  /** Z1 financial bumpers. */
  financialBumpers: SnapshotFinancialBumpers;
  /** Governance manufacturer priorities (Z6/U0) — small list, all rows. */
  manufacturerPriorities: SnapshotManufacturerPriority[];
  capturedAt: string;
}

/** JSON-safe snapshot of the live quote (BigInt/Decimal already stringify via the global json patch). */
const toSnapshot = (quote: QuoteWithChildren, ruleSet: SnapshotRuleSet): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify({ ...quote, ruleSet })) as Prisma.InputJsonValue;

/** A numeric `settings` value by key, or `null` when the row is absent (defensive — never throws). */
const settingNum = async (key: string): Promise<number | null> => {
  const s = await prisma.setting.findUnique({ where: { key } });
  return s?.value != null ? Number(s.value) : null;
};

/**
 * Capture the full governance rule-set in force as an immutable record on a version. Extends the
 * original pricing capture (markups/freight/addOns/rates/marginFloor) with the Z-series governance:
 * margin bands, discount policy + the quote's resolved effective discount, client tier, anomaly
 * rules, financial bumpers, and manufacturer priorities. Every new field is captured defensively
 * (a missing setting → sensible fallback / null, never a throw); the result is pure JSON.
 */
export const captureRuleSet = async (
  quote: QuoteWithChildren,
  capturedAt: Date = new Date(),
): Promise<SnapshotRuleSet> => {
  const [
    config,
    marginFloor,
    minGrossMargin,
    walkAwayMargin,
    discountCapPct,
    discountNoteThresholdPct,
    defaultDiscountPct,
    anomalyRows,
    manufacturers,
    leadTimeBufferDays,
    audUsdRate,
    humanInTheLoop,
  ] = await Promise.all([
    loadPricingConfig(),
    getMarginFloor(),
    getMinGrossMargin(),
    getWalkAwayMargin(),
    getDiscountCapPct(),
    getDiscountNoteThresholdPct(),
    getDefaultDiscountPct(),
    prisma.anomalyRule.findMany({ orderBy: { key: 'asc' } }),
    prisma.manufacturer.findMany({ orderBy: [{ priority: 'asc' }, { name: 'asc' }] }),
    settingNum('lead_time_buffer_days'),
    settingNum('aud_usd_rate'),
    settingNum('human_in_the_loop'),
  ]);

  const discount = resolveDiscount(quote, defaultDiscountPct);

  const tier = quote.client?.clientTier ?? null;
  const clientTier: SnapshotClientTier | null = tier
    ? {
        name: tier.name,
        preferredFreight: tier.preferredFreight ?? null,
        defaultDiscountPct: tier.defaultDiscountPct != null ? Number(tier.defaultDiscountPct) : null,
      }
    : null;

  return {
    markups: config.markups,
    freight: config.freight,
    addOns: config.addOns,
    rates: config.rates,
    marginFloor,
    minGrossMargin,
    walkAwayMargin,
    discountCapPct,
    discountNoteThresholdPct,
    discount: { pct: discount.pct, source: discount.source, scope: discount.scope },
    clientTier,
    anomalyRules: anomalyRows.map((r) => ({
      key: r.key,
      label: r.label,
      enabled: r.enabled,
      severity: r.severity,
      paramNum: r.paramNum != null ? Number(r.paramNum) : null,
    })),
    financialBumpers: { leadTimeBufferDays, audUsdRate, humanInTheLoop },
    manufacturerPriorities: manufacturers.map((m) => ({ name: m.name, priority: m.priority })),
    capturedAt: capturedAt.toISOString(),
  };
};

export const createVersion = async (
  actor: Actor,
  quoteId: bigint,
  label?: string,
  restoredFrom?: number,
) => {
  const quote = await getQuote(quoteId);
  const ruleSet = await captureRuleSet(quote);
  return prisma.$transaction(async (tx) => {
    const last = await tx.quoteRevision.findFirst({
      where: { quoteId },
      orderBy: { revisionNo: 'desc' },
      select: { revisionNo: true },
    });
    const revisionNo = (last?.revisionNo ?? 0) + 1;
    const version = await tx.quoteRevision.create({
      data: {
        quoteId,
        revisionNo,
        label: label ?? null,
        snapshot: toSnapshot(quote, ruleSet),
        grandTotal: quote.grandTotal,
        restoredFrom: restoredFrom ?? null,
        createdById: actor.id,
      },
      select: { id: true, revisionNo: true, label: true, grandTotal: true, restoredFrom: true, createdAt: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'create',
      entityTable: 'quote_revisions',
      entityId: version.id,
      changes: [{ field: 'revision_no', oldValue: null, newValue: String(revisionNo) }],
    });
    return version;
  });
};

/**
 * Deterministic "re-run after new info" (P1-19e.2): recompute the quote from its current persisted
 * state, then capture a new immutable version whose label is a short before→after change summary.
 * AI pre-fill is explicitly out of scope — this is the deterministic recompute path.
 */
export const rerunQuote = async (actor: Actor, quoteId: bigint) => {
  const before = await getQuote(quoteId);
  const oldTotal = before.grandTotal.toString();
  const recomputed = await recomputeQuote(actor.id, quoteId);
  const newTotal = recomputed.grandTotal.toString();
  const label = `Re-run — grand total ${oldTotal} -> ${newTotal}`;
  return createVersion(actor, quoteId, label);
};

export const listVersions = async (quoteId: bigint) => {
  await getQuote(quoteId);
  return prisma.quoteRevision.findMany({
    where: { quoteId },
    orderBy: { revisionNo: 'desc' },
    select: {
      revisionNo: true,
      label: true,
      grandTotal: true,
      restoredFrom: true,
      createdAt: true,
      createdBy: { select: { name: true } },
    },
  });
};

const loadSnapshot = async (quoteId: bigint, revisionNo: number) => {
  const rev = await prisma.quoteRevision.findFirst({ where: { quoteId, revisionNo } });
  if (!rev) throw new Error(`Version ${revisionNo} not found`);
  return rev;
};

export const getVersionSnapshot = async (quoteId: bigint, revisionNo: number) => {
  await getQuote(quoteId);
  const rev = await loadSnapshot(quoteId, revisionNo);
  return { revisionNo: rev.revisionNo, label: rev.label, snapshot: rev.snapshot };
};

// ── Diff ───────────────────────────────────────────────────────────────────────
const NOISY = new Set(['createdAt', 'updatedAt', 'id', 'changedAt']);

const flatten = (value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NOISY.has(k)) continue;
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
};

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

export const diffVersions = async (quoteId: bigint, a: number, b: number): Promise<DiffEntry[]> => {
  await getQuote(quoteId);
  const [ra, rb] = await Promise.all([loadSnapshot(quoteId, a), loadSnapshot(quoteId, b)]);
  const fa = flatten(ra.snapshot);
  const fb = flatten(rb.snapshot);
  const paths = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const diffs: DiffEntry[] = [];
  for (const p of paths) {
    const from = fa[p];
    const to = fb[p];
    if (JSON.stringify(from) !== JSON.stringify(to)) diffs.push({ path: p, from: from ?? null, to: to ?? null });
  }
  return diffs.sort((x, y) => x.path.localeCompare(y.path));
};

// ── Rollback (restore a prior snapshot as a new version) ────────────────────────
interface SnapScreen {
  screenName?: string | null;
  ledProductId?: string | null;
  qty?: number;
  desiredWidthMm?: number | null;
  desiredHeightMm?: number | null;
  rotateCabinets?: boolean;
  gobId?: string | null;
  frameId?: string | null;
  trimId?: string | null;
  hangingBarId?: string | null;
  engineeringId?: string | null;
  installMethodId?: string | null;
  freightOptionId?: string | null;
  warrantyId?: string | null;
  serviceHoursId?: string | null;
  accessEquipmentId?: string | null;
  resolutionWpx?: number | null;
  resolutionHpx?: number | null;
  weightKg?: string | null;
  labourHours?: string | null;
  freightKg?: string | null;
  priceScreenMediaplayer?: string | null;
  priceFrameTrim?: string | null;
  priceServices?: string | null;
  priceTotal?: string | null;
  components?: Array<Record<string, unknown>>;
  costBreakdown?: Array<Record<string, unknown>>;
}

const bid = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as string));

export const rollbackToVersion = async (actor: Actor, quoteId: bigint, revisionNo: number) => {
  await getQuote(quoteId);
  const rev = await loadSnapshot(quoteId, revisionNo);
  const snap = rev.snapshot as unknown as {
    clientId?: string | null;
    locationId?: string | null;
    resellerMarkup?: string;
    ledScreens?: SnapScreen[];
    licences?: Array<{ licenceComponentId?: string | null; screenType: string; tier: string; qty: number; isInteractive: boolean }>;
  };

  await prisma.$transaction(async (tx) => {
    // Replace the live screen tree with the snapshot's (history stays in quote_revisions).
    await tx.quoteLedScreen.deleteMany({ where: { quoteId } });
    await tx.quoteLicence.deleteMany({ where: { quoteId } });

    for (const s of snap.ledScreens ?? []) {
      await tx.quoteLedScreen.create({
        data: {
          quoteId,
          screenName: s.screenName ?? null,
          ledProductId: bid(s.ledProductId),
          qty: s.qty ?? 1,
          desiredWidthMm: s.desiredWidthMm ?? null,
          desiredHeightMm: s.desiredHeightMm ?? null,
          rotateCabinets: s.rotateCabinets ?? false,
          gobId: bid(s.gobId),
          frameId: bid(s.frameId),
          trimId: bid(s.trimId),
          hangingBarId: bid(s.hangingBarId),
          engineeringId: bid(s.engineeringId),
          installMethodId: bid(s.installMethodId),
          freightOptionId: bid(s.freightOptionId),
          warrantyId: bid(s.warrantyId),
          serviceHoursId: bid(s.serviceHoursId),
          accessEquipmentId: bid(s.accessEquipmentId),
          resolutionWpx: s.resolutionWpx ?? null,
          resolutionHpx: s.resolutionHpx ?? null,
          weightKg: s.weightKg ?? null,
          labourHours: s.labourHours ?? null,
          freightKg: s.freightKg ?? null,
          priceScreenMediaplayer: s.priceScreenMediaplayer ?? null,
          priceFrameTrim: s.priceFrameTrim ?? null,
          priceServices: s.priceServices ?? null,
          priceTotal: s.priceTotal ?? null,
          components: {
            create: (s.components ?? []).map((c) => ({
              componentType: c.componentType as never,
              controllerId: bid(c.controllerId),
              ledPeripheralId: bid(c.ledPeripheralId),
              mediaplayerId: bid(c.mediaplayerId),
              peripheralId: bid(c.peripheralId),
              qty: (c.qty as number) ?? 1,
              unitCostSnapshot: (c.unitCostSnapshot as string) ?? null,
              unitSellSnapshot: (c.unitSellSnapshot as string) ?? null,
            })),
          },
          costBreakdown: {
            create: (s.costBreakdown ?? []).map((l) => ({
              lineLabel: l.lineLabel as string,
              category: (l.category as string) ?? null,
              cost: (l.cost as string) ?? null,
              sell: (l.sell as string) ?? null,
            })),
          },
        },
      });
    }
    for (const l of snap.licences ?? []) {
      await tx.quoteLicence.create({
        data: {
          quoteId,
          licenceComponentId: bid(l.licenceComponentId),
          screenType: l.screenType as never,
          tier: l.tier as never,
          qty: l.qty,
          isInteractive: l.isInteractive,
        },
      });
    }
    await tx.quote.update({
      where: { id: quoteId },
      data: {
        clientId: bid(snap.clientId),
        locationId: bid(snap.locationId),
        resellerMarkup: snap.resellerMarkup ?? '0',
        updatedById: actor.id,
      },
    });
    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'update',
      entityTable: 'quotes',
      entityId: quoteId,
      changes: [{ field: 'rolled_back_to', oldValue: null, newValue: String(revisionNo) }],
    });
  });

  await recomputeQuote(actor.id, quoteId);
  // Capture the restored state as a new immutable version (history preserved).
  return createVersion(actor, quoteId, `Restored from v${revisionNo}`, revisionNo);
};
