import { Decimal, d, mul, round } from '@quotezen/shared';
import { toAud } from './currency.js';
import type { PricingConfig } from './constants.js';
import { areaSqm, resolutionPx, snapToCabinets } from './geometry.js';
import type { CabinetSnapInput } from './geometry.js';

/**
 * LED supply cost for a panel: `area(sqm) × cost/sqm(USD) → AUD → × LED markup`.
 * Workbook `(LED 1)`: cost/sqm in USD is converted via `/Reference Data!F3` then marked up by the
 * LED markup `Reference Data!F17`.
 */
export interface LedSupplyInput {
  areaSqm: Decimal | number | string;
  costPerSqmUsd: number;
}

export interface CostSell {
  costAud: Decimal;
  sellAud: Decimal;
}

export const ledSupply = (input: LedSupplyInput, config: PricingConfig): CostSell => {
  const costPerSqmAud = toAud(input.costPerSqmUsd, 'USD', config);
  const costAud = mul(costPerSqmAud, input.areaSqm);
  return { costAud: round(costAud), sellAud: round(mul(costAud, config.markups.led)) };
};

/**
 * Derive the physical/engineering spec of an LED screen from its product and requested size.
 * Mirrors the computed PI block in `(LED 1)`.
 */
export interface LedSpecInput extends CabinetSnapInput {
  pixelPitchHmm: number;
  pixelPitchVmm: number;
  kgPerSqm: number;
  powerAvgWPerSqm?: number;
  powerMaxWPerSqm?: number;
}

export interface LedSpec {
  widthMm: number;
  heightMm: number;
  cabinetCount: number;
  areaSqm: Decimal;
  resolutionWpx: number;
  resolutionHpx: number;
  totalPixels: number;
  weightKg: Decimal;
  powerAvgW: Decimal | null;
  powerMaxW: Decimal | null;
}

export const ledSpec = (input: LedSpecInput): LedSpec => {
  const snapped = snapToCabinets(input);
  const area = areaSqm(snapped.widthMm, snapped.heightMm);
  const resW = resolutionPx(snapped.widthMm, input.pixelPitchHmm);
  const resH = resolutionPx(snapped.heightMm, input.pixelPitchVmm);
  return {
    widthMm: snapped.widthMm,
    heightMm: snapped.heightMm,
    cabinetCount: snapped.cabinetCount,
    areaSqm: round(area, 4),
    resolutionWpx: resW,
    resolutionHpx: resH,
    totalPixels: resW * resH,
    weightKg: round(mul(area, input.kgPerSqm)),
    powerAvgW: input.powerAvgWPerSqm === undefined ? null : round(mul(area, input.powerAvgWPerSqm)),
    powerMaxW: input.powerMaxWPerSqm === undefined ? null : round(mul(area, input.powerMaxWPerSqm)),
  };
};

/**
 * Spares allowance (P1-16.2): a percentage of the supply cost (default from config, 10%), kept as
 * both cost and the marked-up sell at the LED markup.
 */
export const sparesCost = (
  supplyCostAud: Decimal | number | string,
  config: PricingConfig,
  sparesPct = config.addOns.sparesPct,
): CostSell => {
  if (sparesPct < 0) throw new RangeError('led: sparesPct must be >= 0');
  const costAud = mul(supplyCostAud, sparesPct);
  return { costAud: round(costAud), sellAud: round(mul(costAud, config.markups.led)) };
};

/** Packaging allowance (P1-16.2): a configurable percentage of supply cost (0 → no line). */
export const packagingCost = (
  supplyCostAud: Decimal | number | string,
  config: PricingConfig,
): CostSell => {
  const costAud = mul(supplyCostAud, config.addOns.packagingPct);
  return { costAud: round(costAud), sellAud: round(mul(costAud, config.markups.led)) };
};

/** Receiver-card cost (P1-16.2): per-cabinet cost from config (0 → no line), marked up at LED markup. */
export const receiverCardCost = (cabinetCount: number, config: PricingConfig): CostSell => {
  if (cabinetCount < 0) throw new RangeError('led: cabinetCount must be >= 0');
  const costAud = mul(cabinetCount, config.addOns.receiverCardCostAud);
  return { costAud: round(costAud), sellAud: round(mul(costAud, config.markups.led)) };
};

/**
 * Shipping weight used for freight (P1-16.4): the greater of volumetric and actual weight.
 * Volumetric here = actual × the product's volumetric modifier (a packaging-density factor ≥ 1).
 */
export const freightWeightKg = (actualKg: number, volumetricModifier = 1): number => {
  const volumetricKg = actualKg * Math.max(1, volumetricModifier);
  return Math.max(actualKg, volumetricKg);
};

/**
 * Sea-freight cost for a shipment (AUD), from `Reference Data` constants:
 * `(originUsd + transitPerCbmUsd × cbm) / usdRate + destinationAud`, times the sea multiple.
 */
export const seaFreightAud = (cbm: number, config: PricingConfig): Decimal => {
  const { seaOriginUsd, seaTransitPerCbmUsd, seaDestinationAud, seaMultiple } = config.freight;
  const usdPartAud = toAud(d(seaOriginUsd).plus(mul(seaTransitPerCbmUsd, cbm)), 'USD', config);
  return round(usdPartAud.plus(seaDestinationAud).times(seaMultiple));
};
