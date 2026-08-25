import { Decimal, ZERO, d, mul, round, sum } from '@quotezen/shared';
import type { PricingConfig } from './constants.js';

/**
 * LED install / labour estimate (the `LED Install` block in `(LED 1)`).
 *
 * Labour is hours × (assembly rate + location hourly uplift); access-equipment hire and freight are
 * added; the lot is marked up by the service markup (`Reference Data!F16`). Engineering is a
 * pass-through at its listed price (it is already a sell figure), not re-marked-up.
 *
 * This is a transparent estimate that mirrors the workbook's structure; it is intentionally simpler
 * than the spreadsheet's fully itemised breakdown (PM / site-survey / travel lines), which can be
 * layered on later without changing this interface.
 */
export interface LedInstallInput {
  /** Total on-site labour hours for the screen. */
  labourHours: number;
  /** Explicit labour hourly rate override ($/hr). If undefined, uses config.freight.installLabour. */
  labourRate?: number;
  /** Location hourly uplift ($/hr) from `locations.hourly_uplift`. */
  locationHourlyUplift?: number;
  /** Fixed overheads (PM, design, site prep, config, rubbish, consumables, etc.) in AUD. */
  overheadCostAud?: number;
  /** Access-equipment hire (AUD) from `access_equipment.day_rate`. */
  accessEquipmentDayRate?: number;
  /** Freight cost (AUD), including international and local freight, computed by the caller. */
  freightCostAud?: number;
  /**
   * AA6b — flat per-screen freight override (AUD). When defined it **replaces** the weight-based
   * `freightCostAud` as the freight component (the "free-to-location-but-charged ~$90/screen" case),
   * still marked up by the service markup consistently with the normal freight line. When `undefined`
   * (the default), behaviour is byte-for-byte identical to today — a strict no-op.
   */
  freightOverridePerScreenAud?: number;
  /** Engineering option price (AUD) — pass-through, not marked up. */
  engineeringPrice?: number;
}

export interface InstallResult {
  labourHours: number;
  /** Underlying cost (labour + access + freight + overhead + engineering), before service markup. */
  costAud: Decimal;
  /** Sell: (labour + access + freight + overhead) × service markup + engineering. */
  sellAud: Decimal;
}

export const ledInstall = (input: LedInstallInput, config: PricingConfig): InstallResult => {
  if (input.labourHours < 0) throw new RangeError('install: labourHours must be >= 0');
  const baseRate = input.labourRate ?? config.freight.installLabour ?? config.freight.assemblyLabour ?? 95;
  const rate = d(baseRate).plus(input.locationHourlyUplift ?? 0);
  const labour = mul(input.labourHours, rate);
  // AA6b — a flat per-screen freight override (when defined) replaces the weight-based freight; both
  // are marked up by the service markup, so the sell composition is consistent either way.
  const freight =
    input.freightOverridePerScreenAud !== undefined
      ? input.freightOverridePerScreenAud
      : input.freightCostAud;
  const overhead = d(input.overheadCostAud ?? config.freight.standardOverheadAud ?? 0);
  const markupable = sum([labour, input.accessEquipmentDayRate, freight, overhead]);
  const engineering = d(input.engineeringPrice ?? 0);
  const sell = mul(markupable, config.markups.service).plus(engineering);
  const cost = markupable.plus(engineering);
  return {
    labourHours: input.labourHours,
    costAud: round(cost),
    sellAud: round(sell),
  };
};

export interface EstimateInstallHoursOpts {
  /** Area in square metres. */
  areaSqm: number;
  /** Number of cabinets horizontally. */
  cabinetsW?: number;
  /** Number of cabinets vertically. */
  cabinetsH?: number;
  /** Cabinet width in mm. */
  cabinetWMm?: number;
  /** Cabinet height in mm. */
  cabinetHMm?: number;
  /** Whether the product is an "IT" / steel product. */
  isITProduct?: boolean;
  /** Number of screen sides / pieces (default 1). */
  sides?: number;
  /** Base install hours from install method (default 4). */
  baseHours?: number;
  /** Frame install hours from frame option. */
  frameInstallHours?: number;
  /** Hanging install uplift flag. */
  hanging?: boolean;
}

/**
 * Estimate on-site labour hours for an LED screen: base allowance (default 4 hrs) plus size-driven
 * cabinet hours (Excel formula: MROUND(MAX(cabW * cabH * largeCabinet, 4) * areaDiscount * sides, 2)),
 * frame install hours, and a hanging uplift. Mirrors the workbook's model faithfully.
 */
export const estimateInstallHours = (opts: EstimateInstallHoursOpts): number => {
  const base = opts.baseHours ?? 4;
  const frame = opts.frameInstallHours ?? 0;
  const hanging = opts.hanging ? 4 : 0;

  let sizeHours = 0;
  if (opts.cabinetsW !== undefined && opts.cabinetsH !== undefined && opts.cabinetsW > 0 && opts.cabinetsH > 0) {
    const cabW = opts.cabinetsW;
    const cabH = opts.cabinetsH;
    const cabWMm = opts.cabinetWMm ?? 0;
    const cabHMm = opts.cabinetHMm ?? 0;
    const isLargeCabinet = (cabWMm * cabHMm) / 1000 > 600;
    const largeFactor = isLargeCabinet ? (opts.isITProduct ? 1.5 : 2.0) : 1.0;
    const rawCabinetHours = Math.ceil(cabW * cabH * largeFactor);
    const minHours = Math.max(rawCabinetHours, 4);
    const sides = opts.sides && opts.sides > 0 ? opts.sides : 1;
    const areaPerSide = opts.areaSqm / sides;
    const areaDiscount = areaPerSide > 6 ? 0.75 : 1.0;
    const sidesUplift = 1 + (sides - 1) * 0.8;
    // MROUND(..., 2) -> round to nearest multiple of 2
    sizeHours = Math.round((minHours * areaDiscount * sidesUplift) / 2) * 2;
  } else {
    // Fallback if cabinet count not provided
    const raw = Math.ceil(Math.max(4, opts.areaSqm));
    sizeHours = Math.round(raw / 2) * 2;
  }

  return base + sizeHours + frame + hanging;
};

export const ZERO_INSTALL: InstallResult = { labourHours: 0, costAud: ZERO, sellAud: ZERO };
