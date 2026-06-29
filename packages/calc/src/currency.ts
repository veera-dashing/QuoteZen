import { Decimal, d, div } from '@quotezen/shared';
import type { CurrencyCode } from '@quotezen/shared';
import type { PricingConfig } from './constants.js';

/**
 * Convert a foreign-currency cost to AUD.
 *
 * Rates are stored as AUD/X (1 AUD = `rate` units of X), exactly as in the workbook
 * (`Reference Data!F2:F9`). The workbook formula is `=cost / 'Reference Data'!F{n}`, so a USD cost
 * divides by the USD rate to yield AUD.
 */
export const toAud = (
  amount: Decimal | number | string,
  currency: CurrencyCode,
  config: PricingConfig,
): Decimal => {
  const rate = config.rates[currency];
  if (rate === undefined) {
    throw new RangeError(`currency.toAud: no rate configured for ${currency}`);
  }
  return div(d(amount), rate);
};

/** Convert an AUD amount into a target currency (multiply by AUD/X rate). */
export const fromAud = (
  amountAud: Decimal | number | string,
  currency: CurrencyCode,
  config: PricingConfig,
): Decimal => {
  const rate = config.rates[currency];
  if (rate === undefined) {
    throw new RangeError(`currency.fromAud: no rate configured for ${currency}`);
  }
  return d(amountAud).times(rate);
};
