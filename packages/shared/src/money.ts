import Decimal from 'decimal.js';

/**
 * Money / decimal helpers.
 *
 * All financial arithmetic in QuoteZen goes through these helpers so we never do floating-point
 * math on currency. Prisma returns `Decimal` (decimal.js), Postgres stores `NUMERIC`, and the
 * pricing engine works in `Decimal` end-to-end, rounding only at presentation boundaries.
 */
export type Numeric = Decimal | number | string;

// Banker-free, half-up rounding to 2dp is the convention for displayed currency in the workbook.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export const d = (value: Numeric): Decimal => new Decimal(value);

export const ZERO = new Decimal(0);

/** Sum a list of numerics, treating null/undefined as zero. */
export const sum = (values: Array<Numeric | null | undefined>): Decimal =>
  values.reduce<Decimal>((acc, v) => (v === null || v === undefined ? acc : acc.plus(d(v))), ZERO);

/** Multiply two numerics. */
export const mul = (a: Numeric, b: Numeric): Decimal => d(a).times(d(b));

/** a / b. Throws on divide-by-zero rather than returning Infinity. */
export const div = (a: Numeric, b: Numeric): Decimal => {
  const denom = d(b);
  if (denom.isZero()) {
    throw new RangeError('money.div: division by zero');
  }
  return d(a).dividedBy(denom);
};

/** Round to `places` decimal places (default 2) using half-up. */
export const round = (value: Numeric, places = 2): Decimal =>
  d(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);

/** Apply a margin where sell = cost / (1 - margin). Margin is a fraction in [0, 1). */
export const applyMargin = (cost: Numeric, margin: Numeric): Decimal => {
  const m = d(margin);
  if (m.gte(1) || m.lt(0)) {
    throw new RangeError(`money.applyMargin: margin must be in [0,1), got ${m.toString()}`);
  }
  return div(cost, d(1).minus(m));
};

/** Apply a multiplicative markup where sell = cost * markup (e.g. markup 1.4 = +40%). */
export const applyMarkup = (cost: Numeric, markup: Numeric): Decimal => mul(cost, markup);

/** Margin realised on a cost/sell pair: (sell - cost) / sell. Returns 0 when sell is 0. */
export const marginOf = (cost: Numeric, sell: Numeric): Decimal => {
  const s = d(sell);
  if (s.isZero()) return ZERO;
  return div(s.minus(d(cost)), s);
};

/** Serialise a Decimal to a fixed-2dp string for transport/JSON. */
export const toMoneyString = (value: Numeric): string => round(value, 2).toFixed(2);

/** Convert to a JS number — only at display boundaries, never for further math. */
export const toNumber = (value: Numeric): number => d(value).toNumber();

export { Decimal };
