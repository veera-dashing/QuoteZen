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
  /** Location hourly uplift ($/hr) from `locations.hourly_uplift`. */
  locationHourlyUplift?: number;
  /** Access-equipment hire (AUD) from `access_equipment.day_rate`. */
  accessEquipmentDayRate?: number;
  /** Freight cost (AUD), already computed by the caller. */
  freightCostAud?: number;
  /** Engineering option price (AUD) — pass-through, not marked up. */
  engineeringPrice?: number;
}

export interface InstallResult {
  labourHours: number;
  /** Underlying cost (labour + access + freight + engineering), before service markup. */
  costAud: Decimal;
  /** Sell: (labour + access + freight) × service markup + engineering. */
  sellAud: Decimal;
}

export const ledInstall = (input: LedInstallInput, config: PricingConfig): InstallResult => {
  if (input.labourHours < 0) throw new RangeError('install: labourHours must be >= 0');
  const rate = d(config.freight.assemblyLabour).plus(input.locationHourlyUplift ?? 0);
  const labour = mul(input.labourHours, rate);
  const markupable = sum([labour, input.accessEquipmentDayRate, input.freightCostAud]);
  const engineering = d(input.engineeringPrice ?? 0);
  const sell = mul(markupable, config.markups.service).plus(engineering);
  const cost = markupable.plus(engineering);
  return {
    labourHours: input.labourHours,
    costAud: round(cost),
    sellAud: round(sell),
  };
};

/**
 * Estimate on-site labour hours for an LED screen: a base crew allowance plus size-driven hours
 * (≈1 hr/m²), frame install hours, and a hanging uplift. Mirrors the workbook's size-driven model.
 */
export const estimateInstallHours = (opts: {
  areaSqm: number;
  frameInstallHours?: number;
  hanging?: boolean;
}): number => {
  const base = 2;
  const sizeHours = Math.ceil(Math.max(0, opts.areaSqm));
  const frame = opts.frameInstallHours ?? 0;
  const hanging = opts.hanging ? 4 : 0;
  return base + sizeHours + frame + hanging;
};

export const ZERO_INSTALL: InstallResult = { labourHours: 0, costAud: ZERO, sellAud: ZERO };
