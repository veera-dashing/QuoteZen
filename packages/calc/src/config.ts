import { Decimal, d, round } from '@quotezen/shared';
import { areaSqm, resolutionPx, resolveScreenRatio, type ScreenRatioRow } from './geometry.js';

/**
 * Preferred aspect-ratio order (T3 guardrail — BR-033 / DR-021).
 *
 * SOURCE: the Workshop "Capability 4" ratio-preference guidance, mapped onto the labels used by the
 * `screen_ratios` lookup (Reference Data A231:C251 — see packages/db seed `SCREEN_RATIOS`). The order is
 * the preference ranking the estimator should steer toward: 16:9 landscape first, then the wide formats,
 * the near-square / square family, and finally "Fashion Portrait". Dan's note named the portrait format
 * "5:16" but the catalogue's portrait label for that band (~0.5625) is `9:16`, so we use the table label
 * `9:16` (the closest practical, documented here so the mapping is explicit). Anything outside this set is
 * still offered — it just carries a guidance note pointing at the closest preferred ratio.
 */
export const PREFERRED_RATIO_LABELS: readonly string[] = ['16:9', '2:1', '3:1', '5:4', '1:1', '9:16'];

/** Numeric centre of each preferred ratio (W/H), for "closest preferred" guidance. Derived from the label. */
const ratioValue = (label: string): number => {
  const [w, h] = label.split(':').map(Number);
  return w && h ? w / h : Number(label);
};
const PREFERRED_RATIO_VALUES: ReadonlyArray<{ label: string; value: number }> = PREFERRED_RATIO_LABELS.map(
  (label) => ({ label, value: ratioValue(label) }),
);

/** The preferred label numerically closest to a given W:H ratio — used in the non-preferred guidance string. */
const closestPreferred = (widthMm: number, heightMm: number): string => {
  if (heightMm <= 0) return PREFERRED_RATIO_VALUES[0]!.label;
  const ratio = widthMm / heightMm;
  let best = PREFERRED_RATIO_VALUES[0]!;
  for (const r of PREFERRED_RATIO_VALUES) {
    if (Math.abs(r.value - ratio) < Math.abs(best.value - ratio)) best = r;
  }
  return best.label;
};

/**
 * Technical configuration engine (P1-13).
 *
 * Given a desired opening (W×H) and the LED product catalogue, iterate every product, snap the
 * opening to that product's whole-cabinet grid (trying rotation where allowed), and return the valid
 * fits ranked by how well they fill the opening. Pure and deterministic — the same inputs always
 * yield the same ranked list, with stable, explainable tiebreaks.
 *
 * NOTE: exact cut-cabinet costing and the canonical rounding policy are to be confirmed in the
 * rule-extraction session (P1-19h.1) against the real workbooks; this implements the documented
 * whole-cabinet snap + a cut-cabinet *flag* when a partial cabinet would materially improve the fit.
 */
export interface ConfigProduct {
  id: string | number;
  model: string;
  vendor?: string | null;
  minCabinetWMm: number;
  minCabinetHMm: number;
  pixelPitchHmm: number;
  pixelPitchVmm: number;
  category?: string | null;
  serviceAccess?: string | null;
  brightnessNits?: number | null;
  /** 'indoor' | 'outdoor' | null — used by validation, carried through here. */
  environment?: string | null;
  costPerSqmUsd?: number | null;
  kgPerSqm?: number | null;
  rotationAllowed?: boolean;
  // ─── U2: manufacturer sourcing priority + lead time. `manufacturerPriority` is the PRIMARY ranking
  // key (lower = preferred); products with no manufacturer default to a high value so they sort last.
  /** Manufacturer sourcing priority — lower wins. Default {@link NO_MANUFACTURER_PRIORITY} when unset. */
  manufacturerPriority?: number | null;
  /** Manufacturer display name (carried through to the option for the UI). */
  manufacturerName?: string | null;
  /** Manufacturer lead time in days (carried through to the option for the UI). */
  leadTimeDays?: number | null;
}

/** Default priority for a product with no manufacturer — sorts after every real (lower) priority. */
export const NO_MANUFACTURER_PRIORITY = 999;

export interface ConfigRequest {
  desiredWidthMm: number;
  desiredHeightMm: number;
  /** Try rotated cabinet orientation as well (default true). */
  allowRotation?: boolean;
  /** Half-cabinet fraction beyond which a cut cabinet is suggested (default 0.25). */
  cutThreshold?: number;
  ratios: readonly ScreenRatioRow[];
}

/** Whether this candidate is smaller than, equal to, or larger than the opening (T3 over/under). */
export type SizeMode = 'under' | 'exact' | 'over';

export interface ConfigOption {
  productId: string | number;
  model: string;
  vendor?: string | null;
  rotated: boolean;
  widthMm: number;
  heightMm: number;
  cabinetsWide: number;
  cabinetsHigh: number;
  cabinetCount: number;
  areaSqm: Decimal;
  resolutionWpx: number;
  resolutionHpx: number;
  totalPixels: number;
  ratioLabel: string | null;
  /** Snapped area ÷ opening area, ×100 (can exceed 100 when oversized). */
  fillPercent: Decimal;
  /** Signed deviation per axis (snapped − desired), mm. */
  deviationWmm: number;
  deviationHmm: number;
  cutCabinetSuggested: boolean;
  // ─── T3: over/under sizing (Capability 4, FR-059–067; Dan: "ability to Over/Under for options
  // larger/smaller than opening"). Guidance only — these are *additional* candidates, never blocking.
  /** 'under' = whole-cabinet fit smaller than the opening; 'over' = larger; 'exact' = divides evenly. */
  sizeMode: SizeMode;
  /** Signed size delta vs the opening, mm (snapped − desired). Negative = under, positive = over. */
  deltaWidthMm: number;
  deltaHeightMm: number;
  /** Signed overall size delta vs the opening as a %: 100 × (snappedArea/openingArea − 1). */
  sizeDeltaPct: Decimal;
  // ─── T3: aspect-ratio guardrail (BR-033 / DR-021 preference order). Advisory only — never filters.
  /** Is the achieved {@link ratioLabel} in the workbook's preferred-ratio set? */
  ratioPreferred: boolean;
  /** Human guidance when the ratio is not preferred (names the closest preferred); null when preferred. */
  ratioGuidance: string | null;
  // ─── U2: manufacturer priority ordering + lead time (carried from {@link ConfigProduct}).
  /** Manufacturer sourcing priority used as the PRIMARY sort key (lower first). */
  manufacturerPriority: number;
  /** Manufacturer display name (null when the product has no manufacturer). */
  manufacturerName: string | null;
  /** Manufacturer lead time in days (null when unknown). */
  leadTimeDays: number | null;
}

export interface ConfigResult {
  options: ConfigOption[];
  /** Populated only when `options` is empty — why nothing fit (never an error). */
  reasons: string[];
}

/** Which whole-cabinet rounding to apply: 'fit' = nearest (the original snap), 'under' = floor, 'over' = ceil. */
type SnapMode = 'fit' | 'under' | 'over';

/** Snap one axis to whole cabinets under the chosen rounding mode; always ≥ 1 cabinet. */
const snapAxis = (desired: number, unit: number, mode: SnapMode): { mm: number; count: number } => {
  const exact = desired / unit;
  const count =
    mode === 'under'
      ? Math.max(1, Math.floor(exact))
      : mode === 'over'
        ? Math.max(1, Math.ceil(exact))
        : Math.max(1, Math.round(exact));
  return { mm: count * unit, count };
};

const buildOption = (
  product: ConfigProduct,
  req: ConfigRequest,
  rotated: boolean,
  mode: SnapMode = 'fit',
): ConfigOption => {
  const cabW = rotated ? product.minCabinetHMm : product.minCabinetWMm;
  const cabH = rotated ? product.minCabinetWMm : product.minCabinetHMm;
  // 'fit' (nearest cabinet) reproduces the canonical snapToCabinets exactly; under/over force floor/ceil.
  const wa = snapAxis(req.desiredWidthMm, cabW, mode);
  const ha = snapAxis(req.desiredHeightMm, cabH, mode);
  const snapped = {
    widthMm: wa.mm,
    heightMm: ha.mm,
    cabinetsWide: wa.count,
    cabinetsHigh: ha.count,
    cabinetCount: wa.count * ha.count,
  };

  const opening = d(req.desiredWidthMm).times(req.desiredHeightMm);
  const snappedArea = d(snapped.widthMm).times(snapped.heightMm);
  const fillPercent = opening.isZero() ? d(0) : round(snappedArea.dividedBy(opening).times(100), 1);

  const threshold = req.cutThreshold ?? 0.25;
  const widthRemainder = Math.abs(req.desiredWidthMm - snapped.widthMm) / cabW;
  const heightRemainder = Math.abs(req.desiredHeightMm - snapped.heightMm) / cabH;
  const cutCabinetSuggested = widthRemainder > threshold || heightRemainder > threshold;

  const resolutionWpx = resolutionPx(snapped.widthMm, product.pixelPitchHmm);
  const resolutionHpx = resolutionPx(snapped.heightMm, product.pixelPitchVmm);

  // Size classification vs the opening, by signed area delta (under/exact/over). 'exact' = divides evenly.
  const deltaWidthMm = snapped.widthMm - req.desiredWidthMm;
  const deltaHeightMm = snapped.heightMm - req.desiredHeightMm;
  const sizeDeltaPct = opening.isZero() ? d(0) : round(snappedArea.dividedBy(opening).minus(1).times(100), 1);
  const sizeMode: SizeMode = sizeDeltaPct.isZero() ? 'exact' : sizeDeltaPct.isNegative() ? 'under' : 'over';

  // Aspect-ratio guardrail (advisory): is the achieved label in the preferred set?
  const ratioLabel = resolveScreenRatio(snapped.widthMm, snapped.heightMm, req.ratios);
  const ratioPreferred = ratioLabel !== null && PREFERRED_RATIO_LABELS.includes(ratioLabel);
  const closest = closestPreferred(snapped.widthMm, snapped.heightMm);
  const ratioGuidance = ratioPreferred
    ? null
    : `Achieved ${ratioLabel ?? 'ratio'} is not a preferred ratio — closest preferred is ${closest}`;

  return {
    productId: product.id,
    model: product.model,
    vendor: product.vendor,
    rotated,
    widthMm: snapped.widthMm,
    heightMm: snapped.heightMm,
    cabinetsWide: snapped.cabinetsWide,
    cabinetsHigh: snapped.cabinetsHigh,
    cabinetCount: snapped.cabinetCount,
    areaSqm: round(areaSqm(snapped.widthMm, snapped.heightMm), 4),
    resolutionWpx,
    resolutionHpx,
    totalPixels: resolutionWpx * resolutionHpx,
    ratioLabel,
    fillPercent,
    deviationWmm: deltaWidthMm,
    deviationHmm: deltaHeightMm,
    cutCabinetSuggested,
    sizeMode,
    deltaWidthMm,
    deltaHeightMm,
    sizeDeltaPct,
    ratioPreferred,
    ratioGuidance,
    manufacturerPriority: product.manufacturerPriority ?? NO_MANUFACTURER_PRIORITY,
    manufacturerName: product.manufacturerName ?? null,
    leadTimeDays: product.leadTimeDays ?? null,
  };
};

/**
 * U8 — deterministic configuration "confidence" score (0–100, integer).
 *
 * A pure, explainable heuristic over fields already on a {@link ConfigOption}, so the same option
 * always yields the same score (no randomness, no IO). It rewards a build that closely matches the
 * requested opening, lands on a preferred aspect ratio, and stays near the requested size:
 *
 *   score = 100
 *         − min(40, |fillPercent − 100|)     // how far the built area is from filling the opening
 *         − (ratioPreferred ? 0 : 20)        // penalty for a non-preferred aspect ratio (BR-033)
 *         − min(25, |sizeDeltaPct| × 2)      // penalty for over/under sizing vs the opening
 *
 * The result is clamped to [0, 100] and rounded to a whole number. An exact fit on a preferred ratio
 * scores 100; a poor fill / non-preferred ratio / large size delta drives it toward the floor.
 */
export const configConfidence = (opt: ConfigOption): number => {
  const fillPenalty = Math.min(40, Math.abs(opt.fillPercent.toNumber() - 100));
  const ratioPenalty = opt.ratioPreferred ? 0 : 20;
  const sizePenalty = Math.min(25, Math.abs(opt.sizeDeltaPct.toNumber()) * 2);
  const score = 100 - fillPenalty - ratioPenalty - sizePenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
};

/** Absolute area deviation from the opening — the primary ranking key (smaller is better). */
const areaDeviation = (o: ConfigOption, req: ConfigRequest): number =>
  Math.abs(o.widthMm * o.heightMm - req.desiredWidthMm * req.desiredHeightMm);

export const configureScreen = (
  products: readonly ConfigProduct[],
  req: ConfigRequest,
): ConfigResult => {
  if (req.desiredWidthMm <= 0 || req.desiredHeightMm <= 0) {
    return { options: [], reasons: ['Opening width and height must be greater than zero.'] };
  }
  const usable = products.filter(
    (p) => p.minCabinetWMm > 0 && p.minCabinetHMm > 0 && p.pixelPitchHmm > 0 && p.pixelPitchVmm > 0,
  );
  if (usable.length === 0) {
    return { options: [], reasons: ['No products have complete cabinet/pitch data to configure.'] };
  }

  const allowRotation = req.allowRotation ?? true;
  // For each product/orientation, generate the closest fit + the under (round down) + over (round up)
  // variants (T3). Many openings divide evenly on one or both axes, so under/over often coincide with the
  // fit — the dedupe below collapses those. Order matters for the dedupe: the 'fit' candidate is pushed
  // first so it wins the geometry key when an under/over produces identical dimensions.
  const orientations: boolean[] = [false];
  const raw: ConfigOption[] = [];
  for (const product of usable) {
    const square = product.minCabinetWMm === product.minCabinetHMm;
    const useRotation = allowRotation && (product.rotationAllowed ?? true) && !square;
    const oris = useRotation ? [false, true] : orientations;
    for (const rotated of oris) {
      for (const mode of ['fit', 'under', 'over'] as const) {
        raw.push(buildOption(product, req, rotated, mode));
      }
    }
  }

  // Dedupe identical geometry (the fit/under/over collapsing to the same size, rotation of a square
  // cabinet, etc.). First occurrence wins — and we push 'fit' first per orientation, so an exact-fit
  // option is preferred over an under/over that happens to land on the same dimensions.
  const seen = new Set<string>();
  const deduped = raw.filter((o) => {
    const key = `${o.productId}:${o.widthMm}x${o.heightMm}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    return { options: [], reasons: ['No valid cabinet fit for the requested opening.'] };
  }

  // Rank (U2): manufacturer sourcing priority FIRST (lower = preferred), so options group by the
  // manufacturer order the user wants to see; WITHIN each manufacturer, the existing best-fit ranking
  // applies — closest area fit, then exact > under/over at equal deviation, then non-rotated preferred,
  // then a preferred aspect ratio, then fewer cabinets, then model name (stable & explainable).
  const sizeRank: Record<SizeMode, number> = { exact: 0, under: 1, over: 2 };
  deduped.sort((a, b) => {
    if (a.manufacturerPriority !== b.manufacturerPriority) return a.manufacturerPriority - b.manufacturerPriority;
    const da = areaDeviation(a, req);
    const db = areaDeviation(b, req);
    if (da !== db) return da - db;
    if (a.sizeMode !== b.sizeMode) return sizeRank[a.sizeMode] - sizeRank[b.sizeMode];
    if (a.rotated !== b.rotated) return a.rotated ? 1 : -1;
    if (a.ratioPreferred !== b.ratioPreferred) return a.ratioPreferred ? -1 : 1;
    if (a.cabinetCount !== b.cabinetCount) return a.cabinetCount - b.cabinetCount;
    return a.model.localeCompare(b.model);
  });

  return { options: deduped, reasons: [] };
};

/**
 * Good / Better / Best — tiered options (T2; Workshop "Capability 6", FR-057 / FR-067).
 *
 * Pure, deterministic SELECTION of three distinct configurations from the ranked output of
 * {@link configureScreen} (option *generation* is deterministic per the LLM map — only the rationale
 * narrative is generation, so each tier carries a fixed rationale string). The three tiers are:
 *
 *  - **value** ("Budget / Bronze"): the lowest supply *cost/sqm* product that fits (cheapest to build).
 *  - **recommended** ("Ideal"): the engine's top-ranked best-fit config (closest area fit).
 *  - **premium** ("Stretch / Gold"): a higher-spec fit — finest pixel pitch (image quality), with
 *    brightness as a tiebreak.
 *
 * Tiers are picked over *distinct products* where possible: recommended is taken first, then value
 * and premium each skip any product already taken (falling back to the same product only if fewer
 * than three valid products exist — `distinctProducts` reports how many we actually found). Pricing
 * (supply → sell + margin) is NOT done here — it stays in the API where the live PricingConfig + FX
 * live; this only decides *which* configs make up the comparison.
 */
export type OptionTier = 'value' | 'recommended' | 'premium';

export interface TierPick {
  tier: OptionTier;
  label: string;
  rationale: string;
  option: ConfigOption;
}

export interface TierSelection {
  picks: TierPick[];
  /** How many distinct products are represented across the picks (1..3). */
  distinctProducts: number;
}

const TIER_META: Record<OptionTier, { label: string; rationale: string }> = {
  value: {
    label: 'Value (Budget / Bronze)',
    rationale: 'Lowest supply cost that fits the opening — the most economical build.',
  },
  recommended: {
    label: 'Recommended (Ideal)',
    rationale: "The engine's best-fit configuration — closest match to the requested opening.",
  },
  premium: {
    label: 'Premium (Stretch / Gold)',
    rationale: 'Finest pixel pitch that fits — the highest image quality for this opening.',
  },
};

/** Per-product cost/brightness lookup used to rank the value/premium tiers (keyed by productId). */
export interface TierSelectInput {
  /** Supply cost per square metre (USD) — drives the value tier. Missing → treated as +∞ (never cheapest). */
  costPerSqm: Map<string, number>;
  /** Pixel pitch (mm) — drives the premium tier (finer = better). Missing → treated as +∞ (never finest). */
  pixelPitchMm: Map<string, number>;
  /** Brightness (nits) — premium tiebreak (brighter wins). Missing → treated as 0. */
  brightnessNits?: Map<string, number>;
}

/**
 * Select up to three tiers (value/recommended/premium) from ranked configs. Deterministic and stable:
 * given identical ranked input + lookups, always returns the same picks in tier order.
 */
export const selectTiers = (
  ranked: readonly ConfigOption[],
  lookup: TierSelectInput,
): TierSelection => {
  if (ranked.length === 0) return { picks: [], distinctProducts: 0 };

  const key = (o: ConfigOption) => String(o.productId);
  const cost = (o: ConfigOption) => lookup.costPerSqm.get(key(o)) ?? Number.POSITIVE_INFINITY;
  const pitch = (o: ConfigOption) => lookup.pixelPitchMm.get(key(o)) ?? Number.POSITIVE_INFINITY;
  const nits = (o: ConfigOption) => lookup.brightnessNits?.get(key(o)) ?? 0;

  // Recommended = the top-ranked (best-fit) config — index 0 of the ranked list.
  const recommended = ranked[0]!;

  // Value = cheapest cost/sqm; tiebreak by best fit (earlier in ranked order), then model.
  const byCost = [...ranked].sort((a, b) => {
    const ca = cost(a);
    const cb = cost(b);
    if (ca !== cb) return ca - cb;
    return ranked.indexOf(a) - ranked.indexOf(b);
  });

  // Premium = finest pitch; tiebreak by brightness (desc), then best fit, then model.
  const byPremium = [...ranked].sort((a, b) => {
    const pa = pitch(a);
    const pb = pitch(b);
    if (pa !== pb) return pa - pb;
    if (nits(a) !== nits(b)) return nits(b) - nits(a);
    return ranked.indexOf(a) - ranked.indexOf(b);
  });

  // Pick distinct products where possible: take recommended first, then value/premium skipping
  // products already used; fall back to the best available (possibly a repeat) if nothing else fits.
  const usedProducts = new Set<string>([key(recommended)]);
  const firstUnused = (sorted: ConfigOption[]): ConfigOption => {
    const fresh = sorted.find((o) => !usedProducts.has(key(o)));
    return fresh ?? sorted[0]!;
  };

  const value = firstUnused(byCost);
  usedProducts.add(key(value));
  const premium = firstUnused(byPremium);
  usedProducts.add(key(premium));

  const picks: TierPick[] = [
    { tier: 'value', ...TIER_META.value, option: value },
    { tier: 'recommended', ...TIER_META.recommended, option: recommended },
    { tier: 'premium', ...TIER_META.premium, option: premium },
  ];

  const distinctProducts = new Set(picks.map((p) => key(p.option))).size;
  return { picks, distinctProducts };
};
