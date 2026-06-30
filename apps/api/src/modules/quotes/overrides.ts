import { prisma } from '@quotezen/db';
import type { Prisma } from '@quotezen/db';
import type { OverrideTargetType } from '@quotezen/shared';
import type { QuoteWithChildren } from './repository.js';

/**
 * Manual price overrides (P1-17). An override pins a computed value as an input; the recompute path
 * then rolls the pinned value (not the computed one) into the totals, and any affected line is
 * flagged downstream. Data-access only — orchestration (audit + recompute) lives in service.ts.
 */

export type OverrideRow = Prisma.QuoteOverrideGetPayload<{
  include: { createdBy: { select: { id: true; name: true; email: true } } };
}>;

const overrideInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.QuoteOverrideInclude;

export const listOverrides = (quoteId: bigint): Promise<OverrideRow[]> =>
  prisma.quoteOverride.findMany({
    where: { quoteId },
    orderBy: { createdAt: 'asc' },
    include: overrideInclude,
  });

/**
 * Index a quote's active overrides for `target_type:target_id` lookup during recompute/margin.
 * One active override per (quote, type, targetId, field), so a single value per key is correct.
 */
export const overrideMap = (overrides: OverrideRow[]): Map<string, OverrideRow> => {
  const map = new Map<string, OverrideRow>();
  for (const o of overrides) {
    map.set(`${o.targetType}:${o.targetId?.toString() ?? ''}`, o);
  }
  return map;
};

/** The effective LED-screen sell: the pinned override value if one is active, else the computed price. */
export const effectiveLedScreenSell = (
  overrides: Map<string, OverrideRow>,
  screenId: bigint,
  computed: string,
): { value: string; overridden: boolean } => {
  const o = overrides.get(`led_screen_price:${screenId.toString()}`);
  return o ? { value: o.overrideValue.toString(), overridden: true } : { value: computed, overridden: false };
};

/**
 * Drop overrides whose target no longer exists (e.g. the LED screen was deleted) so a stale row can
 * never silently distort totals. Returns the still-valid overrides. Best-effort cleanup; failures
 * are swallowed (the read still succeeds with the filtered set).
 */
export const pruneOrphanOverrides = async (
  quote: QuoteWithChildren,
  overrides: OverrideRow[],
): Promise<OverrideRow[]> => {
  const liveScreenIds = new Set(quote.ledScreens.map((s) => s.id.toString()));
  const orphanIds: bigint[] = [];
  const valid: OverrideRow[] = [];
  for (const o of overrides) {
    const targetType = o.targetType as OverrideTargetType;
    if (targetType === 'led_screen_price' && !(o.targetId && liveScreenIds.has(o.targetId.toString()))) {
      orphanIds.push(o.id);
    } else {
      valid.push(o);
    }
  }
  if (orphanIds.length > 0) {
    await prisma.quoteOverride.deleteMany({ where: { id: { in: orphanIds } } }).catch(() => undefined);
  }
  return valid;
};
