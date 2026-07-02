import { prisma } from '@quotezen/db';
import type { QuoteWithChildren } from './repository.js';
import type { AnomalyFinding } from './anomaly.js';

/**
 * AA7 — engine sanity / alerts (workshop Group G). The FINAL deterministic block.
 *
 * Two ADVISORY-ONLY findings, folded into the same quote-level validation aggregate as the Z4 anomaly
 * rules + AA6a commercial advisories (so the Review Validation card renders them the same way). Neither
 * ever BLOCKS finalisation (no 'error' severity) and neither touches any pricing — they read the already
 * stored figures. Reuses the {@link AnomalyFinding} shape so `validateQuote` can concat them.
 *
 *  • Rule #22 — UNUSUAL_PRICE (warning): a stored LED screen's sell $/m² deviates from the historical
 *    norm (median of prior comparable screens by same product, and separately by same client) beyond a
 *    configurable threshold. Insufficient history ⇒ NOTHING (never a false warning).
 *  • Rule #23 — CUSTOM_METALWORK_LEAD (info): the quote involves custom metalwork (a real custom
 *    engineering option on any LED screen, and/or a manufactured/metalwork item) ⇒ a PM lead-time note.
 */

/** Default deviation threshold (fraction) when the `unusual_price_deviation_pct` setting is unset. */
const DEFAULT_DEVIATION_PCT = 0.3;

/** Minimum number of comparable prior screens before a baseline is trustworthy (else skip). */
const MIN_HISTORY = 2;

const numSetting = async (key: string, fallback: number): Promise<number> => {
  const s = await prisma.setting.findUnique({ where: { key } });
  const n = s?.value != null ? Number(s.value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Screen area in m² from its stored opening dims (mm × mm → m²); null when either dim is missing. */
const screenAreaSqm = (
  screen: QuoteWithChildren['ledScreens'][number],
): number | null => {
  const w = screen.desiredWidthMm ?? null;
  const h = screen.desiredHeightMm ?? null;
  if (w == null || h == null || w <= 0 || h <= 0) return null;
  return (w / 1000) * (h / 1000);
};

/** Median of a non-empty numeric array (robust central baseline). */
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** A prior stored LED screen loaded for the price-history baseline. */
interface HistoryRow {
  desiredWidthMm: number | null;
  desiredHeightMm: number | null;
  priceTotal: { toString(): string } | null;
}

/** Sell $/m² for a history row; null when area or price is missing/zero (excluded from the baseline). */
const historyPricePerSqm = (row: HistoryRow): number | null => {
  const w = row.desiredWidthMm ?? null;
  const h = row.desiredHeightMm ?? null;
  const price = row.priceTotal != null ? Number(row.priceTotal.toString()) : NaN;
  if (w == null || h == null || w <= 0 || h <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const area = (w / 1000) * (h / 1000);
  return price / area;
};

/**
 * Rule #22 — unusual-price flag. For each LED screen on the quote, compute its sell $/m² and compare to
 * two independent historical baselines: prior stored screens with the SAME `ledProductId`, and prior
 * stored screens for the SAME client (join through quotes). Only non-archived quotes; the current
 * quote's own screens are excluded. A baseline with fewer than {@link MIN_HISTORY} comparable priors is
 * treated as insufficient history → that dimension is skipped (never a false warning). When either
 * baseline deviates beyond the threshold, ONE warning is emitted naming the worst dimension.
 */
const evaluateUnusualPrice = async (quote: QuoteWithChildren): Promise<AnomalyFinding[]> => {
  const findings: AnomalyFinding[] = [];
  if (quote.ledScreens.length === 0) return findings;

  const threshold = await numSetting('unusual_price_deviation_pct', DEFAULT_DEVIATION_PCT);
  const productIds = [
    ...new Set(quote.ledScreens.map((s) => s.ledProductId).filter((id): id is bigint => id != null)),
  ];
  const clientId = quote.client?.id ?? null;

  // Load prior comparable screens once: same product OR same client, non-archived, excluding this quote.
  const priorScreens = await prisma.quoteLedScreen.findMany({
    where: {
      quoteId: { not: quote.id },
      quote: { archivedAt: null },
      OR: [
        productIds.length > 0 ? { ledProductId: { in: productIds } } : undefined,
        clientId != null ? { quote: { clientId } } : undefined,
      ].filter((c): c is NonNullable<typeof c> => c != null),
    },
    select: {
      ledProductId: true,
      desiredWidthMm: true,
      desiredHeightMm: true,
      priceTotal: true,
      quote: { select: { clientId: true } },
    },
  });

  // Bucket the priced-per-sqm history by product id and by client id.
  const byProduct = new Map<string, number[]>();
  const byClient = new Map<string, number[]>();
  for (const r of priorScreens) {
    const perSqm = historyPricePerSqm({
      desiredWidthMm: r.desiredWidthMm,
      desiredHeightMm: r.desiredHeightMm,
      priceTotal: r.priceTotal,
    });
    if (perSqm == null) continue;
    if (r.ledProductId != null) {
      const k = r.ledProductId.toString();
      byProduct.set(k, [...(byProduct.get(k) ?? []), perSqm]);
    }
    if (r.quote.clientId != null) {
      const k = r.quote.clientId.toString();
      byClient.set(k, [...(byClient.get(k) ?? []), perSqm]);
    }
  }

  for (const s of quote.ledScreens) {
    const area = screenAreaSqm(s);
    const price = s.priceTotal != null ? Number(s.priceTotal) : NaN;
    if (area == null || !Number.isFinite(price) || price <= 0) continue; // can't evaluate → skip
    const currentPerSqm = price / area;

    // Evaluate against each baseline that has sufficient history; keep the worst deviation.
    const candidates: Array<{ scope: string; baseline: number; deviation: number }> = [];
    const consider = (scope: string, history: number[] | undefined): void => {
      if (!history || history.length < MIN_HISTORY) return; // insufficient history → skip
      const baseline = median(history);
      if (baseline <= 0) return;
      const deviation = Math.abs(currentPerSqm - baseline) / baseline;
      if (deviation > threshold) candidates.push({ scope, baseline, deviation });
    };
    if (s.ledProductId != null) consider('product', byProduct.get(s.ledProductId.toString()));
    if (clientId != null) consider('client', byClient.get(clientId.toString()));

    if (candidates.length === 0) continue;
    const worst = candidates.reduce((a, b) => (b.deviation > a.deviation ? b : a));
    const name = s.ledProduct?.model ?? s.screenName ?? 'LED screen';
    findings.push({
      rule: 'UNUSUAL_PRICE',
      severity: 'warning',
      message:
        `Unusual price: ${name} is $${currentPerSqm.toFixed(0)}/m² vs the ${worst.scope} historical ` +
        `norm of $${worst.baseline.toFixed(0)}/m² (${(worst.deviation * 100).toFixed(0)}% deviation, ` +
        `above the ${(threshold * 100).toFixed(0)}% threshold) — confirm the pricing.`,
      screenId: s.id.toString(),
    });
  }

  return findings;
};

/** True when an LED screen carries a REAL custom engineering option (not the "No Engineering" option). */
const hasCustomEngineering = (screen: QuoteWithChildren['ledScreens'][number]): boolean => {
  const eng = screen.engineering ?? null;
  return eng != null && !/no engineering/i.test(eng.name);
};

/**
 * Rule #23 — custom-metalwork lead-time PM alert. When the quote involves custom metalwork — detected
 * from a real custom engineering option on any LED screen and/or a manufactured/metalwork item — emit a
 * single INFO finding noting the lead-time schedule risk for the PM. Null-safe: no metalwork → nothing.
 */
const evaluateCustomMetalwork = (quote: QuoteWithChildren): AnomalyFinding[] => {
  const engScreens = quote.ledScreens.filter(hasCustomEngineering);
  const hasManufactured = quote.manufacturedItems.length > 0;
  if (engScreens.length === 0 && !hasManufactured) return [];

  const sources: string[] = [];
  if (engScreens.length > 0) {
    const names = [...new Set(engScreens.map((s) => s.engineering!.name))];
    sources.push(`custom engineering (${names.join(', ')})`);
  }
  if (hasManufactured) {
    sources.push(`${quote.manufacturedItems.length} manufactured item(s)`);
  }

  return [
    {
      rule: 'CUSTOM_METALWORK_LEAD',
      severity: 'info',
      message:
        `Custom metalwork carries a 3–4 week lead time — PM to confirm the schedule. ` +
        `Detected: ${sources.join(' + ')}.`,
    },
  ];
};

/**
 * Evaluate the AA7 engine-alert advisories against a loaded quote. Returns quote-level findings
 * (UNUSUAL_PRICE carries a `screenId`). Every finding is advisory (warning/info) — never blocking, no
 * pricing effect. Defensive: missing data ⇒ that check is skipped, never a false finding.
 */
export const evaluateEngineAlerts = async (quote: QuoteWithChildren): Promise<AnomalyFinding[]> => {
  const [unusual] = await Promise.all([evaluateUnusualPrice(quote)]);
  return [...unusual, ...evaluateCustomMetalwork(quote)];
};
