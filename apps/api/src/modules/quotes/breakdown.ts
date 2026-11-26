/**
 * Review-page cost breakdown by TYPE — screen / media player / frame / freight / labour — per screen
 * and for the whole job (all screens together).
 *
 * Pure: the caller (priceQuote) passes each screen's stored lines + its effective price. Each screen's
 * effective extended sell (per-line discounts applied, a pinned override wins — exactly what rolls into
 * the totals) is ALLOCATED across the groups by weight:
 *   • LED: the lines' discounted sells (the LED sell is the sum of its line sells);
 *   • LCD: the lines' discounted costs (the LCD price is its total cost grossed at the fixed LCD margin,
 *     so cost share is the faithful split — the line list-sells don't reconcile to it).
 * So a screen's groups always add up to that screen's price, and the job column to the screens' total.
 * Figures are before the quote-level (client) discount, which applies to the up-front total.
 */

export const BREAKDOWN_GROUPS = [
  { key: 'screen', label: 'Screen' },
  { key: 'mediaplayer', label: 'Media player' },
  { key: 'frame', label: 'Frame, trim & bracket' },
  { key: 'freight', label: 'Freight & delivery' },
  { key: 'labour', label: 'Labour & install' },
  { key: 'other', label: 'Other' },
] as const;
export type BreakdownGroup = (typeof BREAKDOWN_GROUPS)[number]['key'];

/**
 * Group of one stored LED cost-breakdown line, from its bucket (`category`) and label.
 * Buckets: screen_mediaplayer (supply, spares, controller, mediaplayer, …) · frame_trim · services.
 */
export const ledLineGroup = (category: string | null | undefined, label: string): BreakdownGroup => {
  const l = label.trim().toLowerCase();
  if (category === 'services') {
    if (/^install, labour & freight/.test(l)) return 'labour'; // older quotes: one combined line (not split)
    if (/freight|delivery|warehouse/.test(l)) return 'freight';
    if (/^engineering/.test(l)) return 'other';
    return 'labour'; // install, configuration, PM, consumables, access equipment, rubbish removal…
  }
  if (category === 'frame_trim') return 'frame';
  if (category === 'screen_mediaplayer') {
    // "Mediaplayer — X" / "Mediaplayer (none)" and mediaplayer peripherals ("Peripheral — X"; an LED
    // peripheral is "LED peripheral — X" and stays with the screen).
    if (/^mediaplayer|^peripheral\b/.test(l)) return 'mediaplayer';
    return 'screen';
  }
  return 'other';
};

/** Group of one LCD line item, from its item type. */
export const lcdItemGroup = (itemType: string): BreakdownGroup => {
  switch (itemType) {
    case 'display':
      return 'screen';
    case 'mediaplayer':
      return 'mediaplayer';
    case 'bracket':
      return 'frame';
    case 'location_fee':
      return 'freight';
    case 'install':
    case 'labour':
      return 'labour';
    default:
      return 'other'; // warranty, anything new
  }
};

export interface BreakdownLineInput {
  group: BreakdownGroup;
  /** Allocation weight (LED: discounted sell; LCD: discounted cost). Only ratios matter. */
  weight: number;
  /** Extended cost of the line for this screen (× screen qty for LED). */
  cost: number;
}

export interface BreakdownScreenInput {
  screenId: string;
  name: string;
  type: 'led' | 'lcd';
  qty: number;
  /** The screen's effective EXTENDED sell — what rolls into the totals. */
  effectiveSell: number;
  lines: BreakdownLineInput[];
}

export interface GroupAmount {
  sell: number;
  /** Null when cost is hidden for the caller's role. */
  cost: number | null;
}
export type GroupAmounts = Record<BreakdownGroup, GroupAmount>;

export interface QuoteBreakdown {
  groups: ReadonlyArray<{ key: BreakdownGroup; label: string }>;
  screens: Array<{ screenId: string; name: string; type: 'led' | 'lcd'; qty: number; groups: GroupAmounts; total: number }>;
  job: { groups: GroupAmounts; total: number };
}

const cents = (n: number): number => Math.round(n * 100) / 100;

const emptyGroups = (showCost: boolean): GroupAmounts =>
  Object.fromEntries(BREAKDOWN_GROUPS.map((g) => [g.key, { sell: 0, cost: showCost ? 0 : null }])) as GroupAmounts;

/** Split `total` across groups in proportion to `weights`, to the cent, summing exactly to `total`. */
const allocate = (total: number, weights: Record<BreakdownGroup, number>): Record<BreakdownGroup, number> => {
  const keys = BREAKDOWN_GROUPS.map((g) => g.key);
  const sumW = keys.reduce((a, k) => a + Math.max(0, weights[k]), 0);
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<BreakdownGroup, number>;
  if (total === 0) return out;
  if (sumW <= 0) {
    out.other = cents(total); // a price with nothing to split it by (e.g. a pinned price, no lines)
    return out;
  }
  for (const k of keys) out[k] = cents((total * Math.max(0, weights[k])) / sumW);
  // Put any rounding remainder on the largest group so the parts add up exactly.
  const diff = cents(total - keys.reduce((a, k) => a + out[k], 0));
  if (diff !== 0) {
    const largest = keys.reduce((best, k) => (out[k] > out[best] ? k : best), keys[0]!);
    out[largest] = cents(out[largest] + diff);
  }
  return out;
};

export const buildBreakdown = (screens: readonly BreakdownScreenInput[], showCost: boolean): QuoteBreakdown => {
  const job = emptyGroups(showCost);
  let jobTotal = 0;
  const outScreens = screens.map((s) => {
    const weights = Object.fromEntries(BREAKDOWN_GROUPS.map((g) => [g.key, 0])) as Record<BreakdownGroup, number>;
    const costs = Object.fromEntries(BREAKDOWN_GROUPS.map((g) => [g.key, 0])) as Record<BreakdownGroup, number>;
    for (const l of s.lines) {
      weights[l.group] += l.weight;
      costs[l.group] += l.cost;
    }
    const total = cents(s.effectiveSell);
    const sells = allocate(total, weights);
    const groups = emptyGroups(showCost);
    for (const g of BREAKDOWN_GROUPS) {
      groups[g.key] = { sell: sells[g.key], cost: showCost ? cents(costs[g.key]) : null };
      job[g.key].sell = cents(job[g.key].sell + sells[g.key]);
      if (showCost) job[g.key].cost = cents((job[g.key].cost ?? 0) + costs[g.key]);
    }
    jobTotal = cents(jobTotal + total);
    return { screenId: s.screenId, name: s.name, type: s.type, qty: s.qty, groups, total };
  });
  return { groups: BREAKDOWN_GROUPS, screens: outScreens, job: { groups: job, total: jobTotal } };
};
