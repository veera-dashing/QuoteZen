/**
 * Pricing configuration.
 *
 * The engine is pure and DB-driven: callers pass a `PricingConfig` (sourced at runtime from the
 * `settings` and `exchange_rates` tables). `WORKBOOK_DEFAULTS` mirrors the original
 * "Reference Data" tab and is used by tests and the DB seed so behaviour is traceable to the
 * workbook. Cell references below point at `Reference Data` in `Quote Base V1.3`.
 */
import type { CurrencyCode } from '@quotezen/shared';

export interface Markups {
  /** Reference Data F11 — Philips Markup (×). */
  philips: number;
  /** F12 — LCD Margin (fraction). */
  lcdMargin: number;
  /** F13 — LED Margin (fraction); the final sell margin applied to LED totals. */
  ledMargin: number;
  /** F14 — Other Equipment Mark Up (×). */
  otherEquipment: number;
  /** F15 — Metalwork Markup (×). */
  metalwork: number;
  /** F16 — Service Mark Up (×). */
  service: number;
  /** F17 — LED Markup (×) applied to LED supply lines. */
  led: number;
  /** F18 — Controller Markup (×). */
  controller: number;
  /** F19 — International Shipping Markup (×). */
  internationalShipping: number;
}

export interface FreightConfig {
  /** F10 — Assembly Labour ($/hr). */
  assemblyLabour: number;
  /** F20 — Seafreight origin charges (USD). */
  seaOriginUsd: number;
  /** F21 — Seafreight transit charge per CBM (USD). */
  seaTransitPerCbmUsd: number;
  /** F22 — Seafreight destination charges (AUD). */
  seaDestinationAud: number;
  /** F23 — Seafreight multiple. */
  seaMultiple: number;
}

export interface AddOnConfig {
  /** Spares allowance as a fraction of supply cost (default 0.10). */
  sparesPct: number;
  /** Packaging as a fraction of supply cost (0 = no line until configured). */
  packagingPct: number;
  /** Receiver-card cost per cabinet, AUD (0 = no line until configured). */
  receiverCardCostAud: number;
}

export interface PricingConfig {
  markups: Markups;
  freight: FreightConfig;
  addOns: AddOnConfig;
  /** AUD/X budget rates: 1 AUD = rate units of X. Convert a foreign cost to AUD by dividing. */
  rates: Record<CurrencyCode, number>;
}

export const WORKBOOK_DEFAULTS: PricingConfig = {
  markups: {
    philips: 1.4,
    lcdMargin: 0.3,
    ledMargin: 0.33,
    otherEquipment: 1.6,
    metalwork: 1.5,
    service: 1.65,
    led: 1.5,
    controller: 1.5,
    internationalShipping: 1.5,
  },
  freight: {
    assemblyLabour: 45,
    seaOriginUsd: 660,
    seaTransitPerCbmUsd: 90,
    seaDestinationAud: 1200,
    seaMultiple: 1.3,
  },
  // Spares 10% per the workbook; packaging % and receiver-card cost are admin-configured (0 until set,
  // pending the rule-extraction session — never fabricate a number).
  addOns: { sparesPct: 0.1, packagingPct: 0, receiverCardCostAud: 0 },
  // Reference Data F2:F9 (budget rates).
  rates: {
    AUD: 1,
    USD: 0.6845,
    EUR: 0.6006,
    NZD: 1.21,
    SGD: 0.9,
    ZAR: 11.3449,
    GBP: 0.5175,
    MYR: 2.8501,
  },
};
