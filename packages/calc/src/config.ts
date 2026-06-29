import { Decimal, d, round } from '@quotezen/shared';
import { areaSqm, resolutionPx, resolveScreenRatio, snapToCabinets, type ScreenRatioRow } from './geometry.js';

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
}

export interface ConfigRequest {
  desiredWidthMm: number;
  desiredHeightMm: number;
  /** Try rotated cabinet orientation as well (default true). */
  allowRotation?: boolean;
  /** Half-cabinet fraction beyond which a cut cabinet is suggested (default 0.25). */
  cutThreshold?: number;
  ratios: readonly ScreenRatioRow[];
}

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
}

export interface ConfigResult {
  options: ConfigOption[];
  /** Populated only when `options` is empty — why nothing fit (never an error). */
  reasons: string[];
}

const buildOption = (
  product: ConfigProduct,
  req: ConfigRequest,
  rotated: boolean,
): ConfigOption => {
  const snapped = snapToCabinets({
    desiredWidthMm: req.desiredWidthMm,
    desiredHeightMm: req.desiredHeightMm,
    cabinetWidthMm: product.minCabinetWMm,
    cabinetHeightMm: product.minCabinetHMm,
    rotate: rotated,
  });
  const opening = d(req.desiredWidthMm).times(req.desiredHeightMm);
  const snappedArea = d(snapped.widthMm).times(snapped.heightMm);
  const fillPercent = opening.isZero() ? d(0) : round(snappedArea.dividedBy(opening).times(100), 1);

  const cabW = rotated ? product.minCabinetHMm : product.minCabinetWMm;
  const cabH = rotated ? product.minCabinetWMm : product.minCabinetHMm;
  const threshold = req.cutThreshold ?? 0.25;
  const widthRemainder = Math.abs(req.desiredWidthMm - snapped.widthMm) / cabW;
  const heightRemainder = Math.abs(req.desiredHeightMm - snapped.heightMm) / cabH;
  const cutCabinetSuggested = widthRemainder > threshold || heightRemainder > threshold;

  const resolutionWpx = resolutionPx(snapped.widthMm, product.pixelPitchHmm);
  const resolutionHpx = resolutionPx(snapped.heightMm, product.pixelPitchVmm);

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
    ratioLabel: resolveScreenRatio(snapped.widthMm, snapped.heightMm, req.ratios),
    fillPercent,
    deviationWmm: snapped.widthMm - req.desiredWidthMm,
    deviationHmm: snapped.heightMm - req.desiredHeightMm,
    cutCabinetSuggested,
  };
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
  const raw: ConfigOption[] = [];
  for (const product of usable) {
    raw.push(buildOption(product, req, false));
    if (allowRotation && (product.rotationAllowed ?? true)) {
      const square = product.minCabinetWMm === product.minCabinetHMm;
      if (!square) raw.push(buildOption(product, req, true));
    }
  }

  // Dedupe identical geometry (rotation of a square cabinet, etc.).
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

  // Rank: closest area fit, then non-rotated preferred, then fewer cabinets, then model name (stable).
  deduped.sort((a, b) => {
    const da = areaDeviation(a, req);
    const db = areaDeviation(b, req);
    if (da !== db) return da - db;
    if (a.rotated !== b.rotated) return a.rotated ? 1 : -1;
    if (a.cabinetCount !== b.cabinetCount) return a.cabinetCount - b.cabinetCount;
    return a.model.localeCompare(b.model);
  });

  return { options: deduped, reasons: [] };
};
