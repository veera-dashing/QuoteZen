import { prisma } from '@quotezen/db';
import type { Prisma } from '@quotezen/db';
import { recordAudit } from '../../services/audit.js';
import { getQuote, recomputeQuote, type Actor } from './service.js';
import type { QuoteWithChildren } from './repository.js';

/**
 * Versioning & snapshots (P1-04). A version is an immutable JSON snapshot of the full quote (header +
 * screens + components + computed outputs) at save time. Rollback restores a prior snapshot as a NEW
 * version — history is never destroyed.
 */

/** JSON-safe snapshot of the live quote (BigInt/Decimal already stringify via the global json patch). */
const toSnapshot = (quote: QuoteWithChildren): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(quote)) as Prisma.InputJsonValue;

export const createVersion = async (
  actor: Actor,
  quoteId: bigint,
  label?: string,
  restoredFrom?: number,
) => {
  const quote = await getQuote(quoteId);
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
        snapshot: toSnapshot(quote),
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
