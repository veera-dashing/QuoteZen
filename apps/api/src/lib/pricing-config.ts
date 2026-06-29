import { prisma } from '@quotezen/db';
import type { PricingConfig } from '@quotezen/calc';
import { WORKBOOK_DEFAULTS } from '@quotezen/calc';
import type { CurrencyCode } from '@quotezen/shared';
import { CURRENCY_CODES } from '@quotezen/shared';

/**
 * Build the calc engine's `PricingConfig` from the live `settings` and `exchange_rates` tables, so
 * pricing always reflects the current admin-maintained rates. Falls back to the workbook default for
 * any setting not present in the DB.
 */
export const loadPricingConfig = async (): Promise<PricingConfig> => {
  const [settings, rates] = await Promise.all([
    prisma.setting.findMany(),
    prisma.exchangeRate.findMany({ include: { currency: true } }),
  ]);

  const byKey = new Map(settings.map((s) => [s.key, Number(s.value)]));
  const num = (key: string, fallback: number): number => byKey.get(key) ?? fallback;

  const rateMap = { ...WORKBOOK_DEFAULTS.rates };
  for (const r of rates) {
    const code = r.currency.code as CurrencyCode;
    if (CURRENCY_CODES.includes(code)) {
      rateMap[code] = Number(r.budgetRate);
    }
  }

  const m = WORKBOOK_DEFAULTS.markups;
  const f = WORKBOOK_DEFAULTS.freight;
  return {
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
    rates: rateMap,
  };
};
