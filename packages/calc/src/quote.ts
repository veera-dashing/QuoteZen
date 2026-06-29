import { Decimal, ZERO, applyMarkup, round, sum } from '@quotezen/shared';

/**
 * Quote-level aggregation (the `Summary` tab).
 *
 * Each screen/line contributes an extended sell (sell × qty). Up-front equipment+services totals are
 * separated from recurring (annual licence/data) totals, and an optional reseller markup / currency
 * uplift is applied to the up-front total (`Summary!S1`).
 */
export interface QuoteLineContribution {
  /** Extended sell in AUD (already × qty). */
  extendedSell: Decimal | number | string;
  kind: 'equipment' | 'services' | 'recurring';
}

export interface QuoteTotals {
  equipment: Decimal;
  services: Decimal;
  recurring: Decimal;
  /** Up-front total before reseller markup (equipment + services). */
  upfront: Decimal;
  /** Up-front total after reseller markup. */
  grandTotal: Decimal;
}

export const aggregateQuote = (
  lines: readonly QuoteLineContribution[],
  resellerMarkup = 0,
): QuoteTotals => {
  if (resellerMarkup < 0) throw new RangeError('quote: resellerMarkup must be >= 0');
  const pick = (kind: QuoteLineContribution['kind']): Decimal =>
    sum(lines.filter((l) => l.kind === kind).map((l) => l.extendedSell));

  const equipment = pick('equipment');
  const services = pick('services');
  const recurring = pick('recurring');
  const upfront = equipment.plus(services);
  const grandTotal = applyMarkup(upfront, 1 + resellerMarkup);

  return {
    equipment: round(equipment),
    services: round(services),
    recurring: round(recurring),
    upfront: round(upfront),
    grandTotal: round(grandTotal),
  };
};

export const EMPTY_QUOTE_TOTALS: QuoteTotals = {
  equipment: ZERO,
  services: ZERO,
  recurring: ZERO,
  upfront: ZERO,
  grandTotal: ZERO,
};
