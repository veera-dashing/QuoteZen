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
  /**
   * 'indoor' | 'outdoor' | null (W0). When null, the config engine derives an *effective* environment
   * from brightness (≥ outdoorBrightnessNits → outdoor, else indoor) for the environment filter.
   */
  environment?: 'indoor' | 'outdoor' | null;
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
  /**
   * Per-MODEL recommendation priority — lower wins. Secondary ranking key, applied WITHIN a
   * manufacturer (after {@link manufacturerPriority}, before best-fit). Default
   * {@link DEFAULT_MODEL_PRIORITY} when unset, so a catalogue where every model shares the default
   * ranks purely by fit (unchanged) — an admin lowers a model's value to float it up.
   */
  modelPriority?: number | null;
}

/** Default priority for a product with no manufacturer — sorts after every real (lower) priority. */
export const NO_MANUFACTURER_PRIORITY = 999;

/** Neutral per-model priority (matches the DB default) — all-equal ⇒ model priority is a no-op tiebreak. */
export const DEFAULT_MODEL_PRIORITY = 100;

export interface ConfigRequest {
  desiredWidthMm: number;
  desiredHeightMm: number;
  /** Try rotated cabinet orientation as well (default true). */
  allowRotation?: boolean;
  /** Half-cabinet fraction beyond which a cut cabinet is suggested (default 0.25). */
  cutThreshold?: number;
  ratios: readonly ScreenRatioRow[];
  // ─── W0: environment + viewing-distance filters (both optional; absent → no filtering, unchanged) ───
  /**
   * Requested install environment. When set, only products whose EFFECTIVE environment matches are
   * kept: `product.environment ?? (brightnessNits >= outdoorBrightnessNits ? 'outdoor' : 'indoor')`.
   * Null/omitted → no environment filter.
   */
  environment?: 'indoor' | 'outdoor';
  /**
   * Brightness (nits) threshold for the environment fallback (kept in calc so it stays DB-free).
   * A product with no explicit `environment` and `brightnessNits >= this` is treated as outdoor.
   * Default {@link DEFAULT_OUTDOOR_BRIGHTNESS_NITS}.
   */
  outdoorBrightnessNits?: number;
  /**
   * Approximate viewing distance in metres. Applies the "1mm pixel-pitch : 1m distance" rule —
   * `maxPitchMm = viewingDistanceM` — and EXCLUDES any product whose `pixelPitchHmm` exceeds it
   * (too coarse → visible pixels at that distance). Null/omitted → no distance filter.
   */
  viewingDistanceM?: number;
  /**
   * AA2 — per-customer allowed aspect-ratio labels (e.g. ['16:9','9:16','6:1']). When provided and
   * NON-EMPTY, only configurations whose achieved `ratioLabel` is in this set are returned; if none
   * fit, the result is empty with a clear reason (mirrors the environment filter). Absent/empty →
   * no ratio restriction (unchanged behaviour).
   */
  allowedRatios?: readonly string[];
}

/** Default outdoor-brightness threshold (nits) for the environment fallback (mirrors the seeded setting). */
export const DEFAULT_OUTDOOR_BRIGHTNESS_NITS = 4000;

/** Fine-pitch cutoff (mm): pitch below this recommends a GOB (glue-on-board) coating (mirrors validation). */
export const GOB_RECOMMENDED_PITCH_MM = 2.5;

/** Effective environment of a product: explicit value, else a brightness heuristic (bright → outdoor). */
export const effectiveEnvironment = (
  environment: 'indoor' | 'outdoor' | null | undefined,
  brightnessNits: number | null | undefined,
  outdoorBrightnessNits: number,
): 'indoor' | 'outdoor' => {
  if (environment === 'indoor' || environment === 'outdoor') return environment;
  return brightnessNits != null && brightnessNits >= outdoorBrightnessNits ? 'outdoor' : 'indoor';
};

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
  /** Horizontal pixel pitch (mm) of the chosen product — surfaced for the UI + GOB/viewing-distance logic. */
  pixelPitchMm: number;
  /** W0: fine-pitch (< {@link GOB_RECOMMENDED_PITCH_MM}) → a GOB coating is recommended. Advisory only. */
  gobRecommended: boolean;
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
  /** Per-model recommendation priority — SECONDARY sort key within a manufacturer (lower first). */
  modelPriority: number;
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
    pixelPitchMm: product.pixelPitchHmm,
    gobRecommended: product.pixelPitchHmm < GOB_RECOMMENDED_PITCH_MM,
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
    modelPriority: product.modelPriority ?? DEFAULT_MODEL_PRIORITY,
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
  const complete = products.filter(
    (p) => p.minCabinetWMm > 0 && p.minCabinetHMm > 0 && p.pixelPitchHmm > 0 && p.pixelPitchVmm > 0,
  );
  if (complete.length === 0) {
    return { options: [], reasons: ['No products have complete cabinet/pitch data to configure.'] };
  }

  // ─── W0 filters (applied before iteration; each records a distinct empty-with-reasons message) ───
  const outdoorThreshold = req.outdoorBrightnessNits ?? DEFAULT_OUTDOOR_BRIGHTNESS_NITS;
  let usable = complete;

  // Environment: keep only products whose EFFECTIVE environment matches the request (null → no filter).
  if (req.environment) {
    usable = usable.filter(
      (p) => effectiveEnvironment(p.environment, p.brightnessNits, outdoorThreshold) === req.environment,
    );
    if (usable.length === 0) {
      return {
        options: [],
        reasons: [`No ${req.environment} products available for this opening (by product environment or brightness).`],
      };
    }
  }

  // Viewing distance: max acceptable pitch (mm) ≈ distance (m). Exclude products coarser than that.
  const maxPitchMm = req.viewingDistanceM != null && req.viewingDistanceM > 0 ? req.viewingDistanceM : null;
  if (maxPitchMm != null) {
    usable = usable.filter((p) => p.pixelPitchHmm <= maxPitchMm);
    if (usable.length === 0) {
      return {
        options: [],
        reasons: [`No products fine enough for a ${req.viewingDistanceM}m viewing distance (max pitch ${maxPitchMm}mm).`],
      };
    }
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

  // AA2 — per-customer allowed-ratios filter. Applied AFTER options are built (ratioLabel is per-option
  // geometry) and BEFORE ranking. Empty/absent → no restriction. Empty-with-reasons when nothing fits.
  const allowed = (req.allowedRatios ?? []).map((r) => r.trim()).filter((r) => r.length > 0);
  let ratioFiltered = deduped;
  if (allowed.length > 0) {
    ratioFiltered = deduped.filter((o) => o.ratioLabel !== null && allowed.includes(o.ratioLabel));
    if (ratioFiltered.length === 0) {
      return {
        options: [],
        reasons: [`No configuration matches the client's allowed ratios (${allowed.join(', ')}).`],
      };
    }
  }

  // Rank: manufacturer sourcing priority FIRST (U2, lower = preferred), then per-MODEL priority
  // (admin-set, lower = preferred) as the SECONDARY key — so within a manufacturer the models the admin
  // has prioritised come first; WITHIN an equal (manufacturer, model) priority the existing best-fit
  // ranking applies — closest area fit, then exact > under/over at equal deviation, then non-rotated
  // preferred, then a preferred aspect ratio, then fewer cabinets. W0: when a viewing distance was
  // requested, a MILD "coarsest pitch that still fits (best value)" preference is applied as a
  // low-priority tiebreak (after all the fit/geometry keys, before the model-name final tiebreak) — it
  // never reorders across manufacturers or better fits. Finally model name (stable & explainable).
  // Order of keys:
  //   1. manufacturerPriority  2. modelPriority  3. area deviation  4. exact>under>over  5. non-rotated
  //   6. preferred ratio  7. fewer cabinets  8. [W0 viewing-distance] coarsest pitch  9. model name.
  const sizeRank: Record<SizeMode, number> = { exact: 0, under: 1, over: 2 };
  const preferCoarsest = maxPitchMm != null; // only bias by pitch when the user gave a viewing distance
  ratioFiltered.sort((a, b) => {
    if (a.manufacturerPriority !== b.manufacturerPriority) return a.manufacturerPriority - b.manufacturerPriority;
    if (a.modelPriority !== b.modelPriority) return a.modelPriority - b.modelPriority;
    const da = areaDeviation(a, req);
    const db = areaDeviation(b, req);
    if (da !== db) return da - db;
    if (a.sizeMode !== b.sizeMode) return sizeRank[a.sizeMode] - sizeRank[b.sizeMode];
    if (a.rotated !== b.rotated) return a.rotated ? 1 : -1;
    if (a.ratioPreferred !== b.ratioPreferred) return a.ratioPreferred ? -1 : 1;
    if (a.cabinetCount !== b.cabinetCount) return a.cabinetCount - b.cabinetCount;
    // W0: coarsest pitch first = best value at the requested distance (all remaining fit within maxPitch).
    if (preferCoarsest && a.pixelPitchMm !== b.pixelPitchMm) return b.pixelPitchMm - a.pixelPitchMm;
    return a.model.localeCompare(b.model);
  });

  return { options: ratioFiltered, reasons: [] };
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

  // Recommended = the top-ranked config — index 0 of the ranked list, which already honours
  // manufacturer + model priority (then best fit). Value/Premium below intentionally re-sort by their
  // OWN axis (cheapest cost/sqm · finest pitch) — those are deliberate specialty picks, so they do NOT
  // apply the admin priority order (only Recommended reflects it).
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
