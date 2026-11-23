import { Decimal, ZERO, applyMargin, applyMarkup, d, marginOf, mul, round } from '@quotezen/shared';
/**
 * A priced line item in cost/sell terms. Every catalog line in the workbook reduces to this shape:
 * a cost in AUD and a sell in AUD, derived either by a multiplicative markup (`= cost * markup`) or
 * by a target margin (`= cost / (1 - margin)`).
 */
export interface PricedLine {
  label: string;
  /** Bucket used to roll up into the summary columns. */
  bucket: LineBucket;
  qty: number;
  costAud: Decimal;
  sellAud: Decimal;
}

export type LineBucket = 'screen_mediaplayer' | 'frame_trim' | 'services' | 'freight';

export interface BucketTotals {
  costAud: Decimal;
  sellAud: Decimal;
}

/** Build a line whose sell is `cost * markup` (LED supply, controller, frames, etc.). */
export const markupLine = (
  label: string,
  bucket: LineBucket,
  costAud: Decimal | number | string,
  markup: number,
  qty = 1,
): PricedLine => {
  const cost = mul(costAud, qty);
  return { label, bucket, qty, costAud: cost, sellAud: applyMarkup(cost, markup) };
};

/** Build a line whose sell is `cost / (1 - margin)` (mediaplayer, LCD displays). */
export const marginLine = (
  label: string,
  bucket: LineBucket,
  costAud: Decimal | number | string,
  margin: number,
  qty = 1,
): PricedLine => {
  const cost = mul(costAud, qty);
  return { label, bucket, qty, costAud: cost, sellAud: applyMargin(cost, margin) };
};

/** A line where both cost and sell are already known (catalog rows with explicit sell). */
export const fixedLine = (
  label: string,
  bucket: LineBucket,
  costAud: Decimal | number | string,
  sellAud: Decimal | number | string,
  qty = 1,
): PricedLine => ({
  label,
  bucket,
  qty,
  costAud: mul(costAud, qty),
  sellAud: mul(sellAud, qty),
});

/** Sum a set of lines into per-bucket cost/sell totals. */
export const totalsByBucket = (lines: readonly PricedLine[]): Record<LineBucket, BucketTotals> => {
  const empty = (): BucketTotals => ({ costAud: ZERO, sellAud: ZERO });
  const acc: Record<LineBucket, BucketTotals> = {
    screen_mediaplayer: empty(),
    frame_trim: empty(),
    services: empty(),
    freight: empty(),
  };
  for (const line of lines) {
    const b = acc[line.bucket];
    b.costAud = b.costAud.plus(line.costAud);
    b.sellAud = b.sellAud.plus(line.sellAud);
  }
  return acc;
};

/** Workbook `ROUND(x, -1)`: half-up to the nearest 10. */
export const roundToTen = (value: Decimal | number | string): Decimal =>
  d(value).dividedBy(10).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(10);

/**
 * Re-price lines the way the workbook QUOTES an LED screen: each section's total cost at the LED
 * margin, rounded to $10 — `(LED 1)` J2 = ROUND(O272/(1-F13),-1) (supply), K2 (frame & trim),
 * L2 = ROUND(O321/(1-F13),-1) (install). The per-line markups (column L: LED ×1.5, service ×1.65…)
 * only feed the sheet's reference rows 271/320, never the quoted price.
 *
 * Sections are the summary columns; `freight` folds into services, as in {@link composeScreenTotals}.
 * Each line's sell becomes cost/(1-margin); the $10 rounding residual lands on the section's
 * largest-cost line so the itemised lines still sum exactly to the quoted section total.
 */
export const priceSectionsAtMargin = (lines: readonly PricedLine[], margin: number): PricedLine[] => {
  const sectionOf = (b: LineBucket): LineBucket => (b === 'freight' ? 'services' : b);
  const out = lines.map((l) => ({ ...l, sellAud: round(applyMargin(l.costAud, margin)) }));
  const sections = new Set(out.map((l) => sectionOf(l.bucket)));
  for (const section of sections) {
    const idx = out.flatMap((l, i) => (sectionOf(l.bucket) === section ? [i] : []));
    const cost = idx.reduce((acc, i) => acc.plus(out[i]!.costAud), ZERO);
    const target = roundToTen(applyMargin(cost, margin));
    const lineSum = idx.reduce((acc, i) => acc.plus(out[i]!.sellAud), ZERO);
    const anchor = idx.reduce((best, i) => (out[i]!.costAud.greaterThan(out[best]!.costAud) ? i : best), idx[0]!);
    out[anchor]!.sellAud = out[anchor]!.sellAud.plus(target.minus(lineSum));
  }
  return out;
};

export interface ScreenTotals {
  screenMediaplayerSell: Decimal;
  frameTrimSell: Decimal;
  servicesSell: Decimal;
  freightSell: Decimal;
  totalCost: Decimal;
  totalSell: Decimal;
  /** Realised blended margin across the screen. */
  margin: Decimal;
}

/** Roll a screen's lines up into the four summary columns + totals, rounded to 2dp. */
export const composeScreenTotals = (lines: readonly PricedLine[]): ScreenTotals => {
  const t = totalsByBucket(lines);
  const totalCost = t.screen_mediaplayer.costAud
    .plus(t.frame_trim.costAud)
    .plus(t.services.costAud)
    .plus(t.freight.costAud);
  const totalSell = t.screen_mediaplayer.sellAud
    .plus(t.frame_trim.sellAud)
    .plus(t.services.sellAud)
    .plus(t.freight.sellAud);
  return {
    screenMediaplayerSell: round(t.screen_mediaplayer.sellAud),
    frameTrimSell: round(t.frame_trim.sellAud),
    servicesSell: round(t.services.sellAud.plus(t.freight.sellAud)),
    freightSell: round(t.freight.sellAud),
    totalCost: round(totalCost),
    totalSell: round(totalSell),
    margin: round(marginOf(totalCost, totalSell), 4),
  };
};

export { d };
