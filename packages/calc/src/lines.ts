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
