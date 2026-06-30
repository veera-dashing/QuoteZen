import { prisma } from '@quotezen/db';
import type { PricingConfig } from '@quotezen/calc';
import { WORKBOOK_DEFAULTS } from '@quotezen/calc';
import type { CurrencyCode } from '@quotezen/shared';
import { CURRENCY_CODES } from '@quotezen/shared';

/**
 * Pricing context: the calc `PricingConfig` plus the set of currency codes whose rate came from the
 * live `exchange_rates` table (as opposed to the workbook fallback). The latter lets the pricing path
 * hard-stop when a conversion needs a rate that the DB doesn't actually provide (P1-07.5) instead of
 * silently using a stale workbook number.
 */
export interface PricingContext {
  config: PricingConfig;
  /** Currency codes whose `rates[code]` was sourced from `exchange_rates` (not the workbook fallback). */
  dbRateCodes: Set<CurrencyCode>;
}

/**
 * Build the calc engine's pricing context from the live `settings` and `exchange_rates` tables, so
 * pricing always reflects the current admin-maintained rates. Falls back to the workbook default for
 * any setting not present in the DB, while recording which currency rates are genuinely DB-backed.
 */
export const loadPricingContext = async (): Promise<PricingContext> => {
  const [settings, rates] = await Promise.all([
    prisma.setting.findMany(),
    prisma.exchangeRate.findMany({ include: { currency: true } }),
  ]);

  const byKey = new Map(settings.map((s) => [s.key, Number(s.value)]));
  const num = (key: string, fallback: number): number => byKey.get(key) ?? fallback;

  const rateMap = { ...WORKBOOK_DEFAULTS.rates };
  const dbRateCodes = new Set<CurrencyCode>();
  for (const r of rates) {
    const code = r.currency.code as CurrencyCode;
    if (CURRENCY_CODES.includes(code)) {
      rateMap[code] = Number(r.budgetRate);
      dbRateCodes.add(code);
    }
  }

  const m = WORKBOOK_DEFAULTS.markups;
  const f = WORKBOOK_DEFAULTS.freight;
  const a = WORKBOOK_DEFAULTS.addOns;
  const config: PricingConfig = {
    markups: {
      philips: num('philips_markup', m.philips),
      lcdMargin: num('lcd_margin', m.lcdMargin),
      ledMargin: num('led_margin', m.ledMargin),
      otherEquipment: num('other_equipment_markup', m.otherEquipment),
      metalwork: num('metalwork_markup', m.metalwork),
      service: num('service_markup', m.service),
      led: num('led_markup', m.led),
      controller: num('controller_markup', m.controller),
      internationalShipping: num('international_shipping_markup', m.internationalShipping),
    },
    freight: {
      assemblyLabour: num('assembly_labour', f.assemblyLabour),
      seaOriginUsd: f.seaOriginUsd,
      seaTransitPerCbmUsd: f.seaTransitPerCbmUsd,
      seaDestinationAud: f.seaDestinationAud,
      seaMultiple: f.seaMultiple,
    },
    addOns: {
      sparesPct: num('spares_pct', a.sparesPct),
      packagingPct: num('packaging_pct', a.packagingPct),
      receiverCardCostAud: num('receiver_card_cost', a.receiverCardCostAud),
    },
    rates: rateMap,
  };
  return { config, dbRateCodes };
};

/**
 * Build just the calc `PricingConfig` (thin wrapper over {@link loadPricingContext}). Use the context
 * form when you need to enforce that a conversion's rate is DB-backed.
 */
export const loadPricingConfig = async (): Promise<PricingConfig> => (await loadPricingContext()).config;
