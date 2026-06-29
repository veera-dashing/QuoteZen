import { Decimal, d, mul } from '@quotezen/shared';

/**
 * LED screen geometry — replicates the cabinet-snapping and resolution logic from `(LED 1)`.
 *
 * A physical LED wall is built from whole cabinets, so the requested size is snapped to the nearest
 * multiple of the cabinet dimension. When cabinets are rotated, width and height swap their cabinet
 * units. Workbook: `E249 = IF(C13="Y", ROUND(E246/M5,0)*M5, ROUND(E246/L5,0)*L5)`.
 */
export interface CabinetSnapInput {
  desiredWidthMm: number;
  desiredHeightMm: number;
  /** Min cabinet width (mm) — `Reference Data` product col L. */
  cabinetWidthMm: number;
  /** Min cabinet height (mm) — product col M. */
  cabinetHeightMm: number;
  rotate?: boolean;
}

export interface SnappedSize {
  widthMm: number;
  heightMm: number;
  /** Whole cabinets across × down. */
  cabinetsWide: number;
  cabinetsHigh: number;
  cabinetCount: number;
}

const snap = (desired: number, unit: number): { mm: number; count: number } => {
  if (unit <= 0) throw new RangeError('geometry: cabinet unit must be > 0');
  const count = Math.max(1, Math.round(desired / unit));
  return { mm: count * unit, count };
};

export const snapToCabinets = (input: CabinetSnapInput): SnappedSize => {
  const widthUnit = input.rotate ? input.cabinetHeightMm : input.cabinetWidthMm;
  const heightUnit = input.rotate ? input.cabinetWidthMm : input.cabinetHeightMm;
  const w = snap(input.desiredWidthMm, widthUnit);
  const h = snap(input.desiredHeightMm, heightUnit);
  return {
    widthMm: w.mm,
    heightMm: h.mm,
    cabinetsWide: w.count,
    cabinetsHigh: h.count,
    cabinetCount: w.count * h.count,
  };
};

/** Active area in square metres: `w * h / 1_000_000`. */
export const areaSqm = (widthMm: number, heightMm: number): Decimal =>
  mul(widthMm, heightMm).dividedBy(1_000_000);

/** Pixel resolution along one axis: `round(sizeMm / pixelPitchMm)`. */
export const resolutionPx = (sizeMm: number, pixelPitchMm: number): number => {
  if (pixelPitchMm <= 0) throw new RangeError('geometry: pixel pitch must be > 0');
  return Math.round(sizeMm / pixelPitchMm);
};

export interface ScreenRatioRow {
  minValue: number;
  maxValue: number;
  ratioLabel: string;
}

/** Resolve the human ratio label for a width/height, using the `screen_ratios` lookup table. */
export const resolveScreenRatio = (
  widthMm: number,
  heightMm: number,
  ratios: readonly ScreenRatioRow[],
): string | null => {
  if (heightMm <= 0) throw new RangeError('geometry: height must be > 0');
  const ratio = d(widthMm).dividedBy(heightMm).toNumber();
  const match = ratios.find((r) => ratio >= r.minValue && ratio <= r.maxValue);
  return match ? match.ratioLabel : null;
};
