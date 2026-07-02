/**
 * LCD Good / Better / Best tiering (Block AA3b — workshop rule #15 / gap item 64:
 * "we recommend the Philips, but here's a cheaper option").
 *
 * The LED analogue is {@link selectTiers} (config.ts) — that flow runs over the "lego" LED config
 * engine (best-fit cabinets). LCD is fixed-size hardware, so there is no config engine: this simply
 * picks value/recommended/premium DISPLAY products from a candidate list at different price points.
 *
 * Pure & deterministic: given identical candidates it always returns the same picks in tier order,
 * with stable tie-breaks (size distance → preferred brand → lowest sell → model name).
 */

/** Preferred brand for the "recommended" tie-break — the workshop's "we recommend the Philips". */
export const LCD_PREFERRED_BRAND = 'Philips';

/** A candidate LCD display product (mapped from a display_catalog row). */
export interface LcdCandidate {
  id: string;
  model: string;
  brand: string | null;
  /** Panel size in inches, when known. Drives the recommended best-fit heuristic. */
  sizeIn: number | null;
  /** Supply cost (AUD). */
  costAud: number;
  /** Sell price (AUD) — drives value (cheapest) / premium (dearest). */
  sellAud: number;
  category: string | null;
}

export interface LcdTierPick {
  tier: 'value' | 'recommended' | 'premium';
  label: string;
  rationale: string;
  candidate: LcdCandidate;
}

export interface LcdTierSelection {
  picks: LcdTierPick[];
  /** Number of distinct products across the picks (≤ 3). */
  distinctProducts: number;
}

export interface LcdTierOpts {
  /** Target panel size (inches). When set, recommended = the candidate whose size is closest. */
  targetSizeIn?: number | null;
}

const TIER_META = {
  value: { label: 'Value (Good)', rationale: 'Lowest cost' },
  recommended: { label: 'Recommended (Better)', rationale: 'Best fit / preferred brand' },
  premium: { label: 'Premium (Best)', rationale: 'Premium' },
} as const;

const isPreferred = (c: LcdCandidate): boolean =>
  (c.brand ?? '').toLowerCase() === LCD_PREFERRED_BRAND.toLowerCase();

/**
 * Select up to three LCD display tiers (value / recommended / premium) from a candidate list.
 *
 *  - **value** = lowest sell (cheapest). Tie-break: preferred brand, then model name.
 *  - **recommended** = the default pick. With `targetSizeIn`: the candidate whose `sizeIn` is closest
 *    (tie-break preferred brand → lowest sell → model). Without size data: the preferred-brand
 *    mid-priced option, else the median-priced.
 *  - **premium** = highest sell (or, on a sell tie, largest size). Tie-break: model name.
 *
 * Distinct products across the tiers where possible (dedupe, mirroring `selectTiers`). Handles fewer
 * than three candidates gracefully (returns only what exists).
 */
export const selectLcdTiers = (
  candidates: readonly LcdCandidate[],
  opts: LcdTierOpts = {},
): LcdTierSelection => {
  if (candidates.length === 0) return { picks: [], distinctProducts: 0 };

  const byModel = (a: LcdCandidate, b: LcdCandidate) => a.model.localeCompare(b.model);

  // Value = cheapest sell; tie-break preferred brand, then model.
  const byValue = [...candidates].sort((a, b) => {
    if (a.sellAud !== b.sellAud) return a.sellAud - b.sellAud;
    if (isPreferred(a) !== isPreferred(b)) return isPreferred(a) ? -1 : 1;
    return byModel(a, b);
  });

  // Premium = dearest sell; tie-break largest size, then model.
  const byPremium = [...candidates].sort((a, b) => {
    if (a.sellAud !== b.sellAud) return b.sellAud - a.sellAud;
    const sa = a.sizeIn ?? -Infinity;
    const sb = b.sizeIn ?? -Infinity;
    if (sa !== sb) return sb - sa;
    return byModel(a, b);
  });

  // Recommended = best fit / preferred brand.
  const target = opts.targetSizeIn;
  const hasTarget = target != null && Number.isFinite(target);
  const withSize = candidates.filter((c) => c.sizeIn != null);
  let recommended: LcdCandidate;
  if (hasTarget && withSize.length > 0) {
    // Closest size to the target; tie-break preferred brand → lowest sell → model.
    recommended = [...withSize].sort((a, b) => {
      const da = Math.abs((a.sizeIn as number) - (target as number));
      const db = Math.abs((b.sizeIn as number) - (target as number));
      if (da !== db) return da - db;
      if (isPreferred(a) !== isPreferred(b)) return isPreferred(a) ? -1 : 1;
      if (a.sellAud !== b.sellAud) return a.sellAud - b.sellAud;
      return byModel(a, b);
    })[0]!;
  } else {
    // No usable size data: prefer the preferred-brand mid-priced option, else the median-priced.
    const bySell = [...candidates].sort((a, b) => {
      if (a.sellAud !== b.sellAud) return a.sellAud - b.sellAud;
      return byModel(a, b);
    });
    const preferred = bySell.filter(isPreferred);
    const pool = preferred.length > 0 ? preferred : bySell;
    recommended = pool[Math.floor((pool.length - 1) / 2)]!;
  }

  // Distinct where possible: recommended first, then value/premium skipping used products,
  // falling back to the best available (possibly a repeat).
  const used = new Set<string>([recommended.id]);
  const firstUnused = (sorted: LcdCandidate[]): LcdCandidate =>
    sorted.find((c) => !used.has(c.id)) ?? sorted[0]!;

  const value = firstUnused(byValue);
  used.add(value.id);
  const premium = firstUnused(byPremium);
  used.add(premium.id);

  const picks: LcdTierPick[] = [
    { tier: 'value', ...TIER_META.value, candidate: value },
    { tier: 'recommended', ...TIER_META.recommended, candidate: recommended },
    { tier: 'premium', ...TIER_META.premium, candidate: premium },
  ];

  const distinctProducts = new Set(picks.map((p) => p.candidate.id)).size;
  return { picks, distinctProducts };
};
