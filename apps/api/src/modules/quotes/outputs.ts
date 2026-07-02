import {
  buildLcdOrderList,
  describeLcdScreen,
  describeLedScreen,
  resolveScreenRatio,
  type ScreenRatioRow,
} from '@quotezen/calc';
import { prisma } from '@quotezen/db';
import type { QuoteWithChildren } from './repository.js';

/** Load the screen-ratio lookup so descriptions can use the named ratio (e.g. 9:16) not raw gcd. */
export const loadRatios = async (): Promise<ScreenRatioRow[]> =>
  (await prisma.screenRatio.findMany()).map((r) => ({
    minValue: Number(r.minValue),
    maxValue: Number(r.maxValue),
    ratioLabel: r.ratioLabel,
  }));

/**
 * Quote outputs (P1-18): auto descriptions, procurement BOM/PI, solution summary, PM handoff.
 * All derived deterministically from the committed quote so the narrative matches the configuration
 * (BR-093). Raw cost is gated by `showCost` (BR-081).
 */

export const DEFAULT_ASSUMPTIONS = [
  'Pricing is based on the screen configuration and site information available at the time of quoting.',
  'Site is ready for installation (power and data provided by others to the agreed locations).',
  'Installation during standard business hours unless otherwise stated.',
  'Spares are included at the configured percentage of the LED supply.',
];

export const DEFAULT_EXCLUSIONS = [
  'Engineering certification unless explicitly listed.',
  'Traffic management, barricading and permits.',
  'Builders works, structural reinforcement and making good.',
  'Content creation and ongoing content management.',
];

export const DEFAULT_TERMS = [
  'All prices are ex-GST and in the quoted currency.',
  'Quote valid for 14 days from the issue date.',
  'Equipment prices are firm for the described solution; changes may affect price.',
  'Warranty is as stated per screen; onsite support subject to a support agreement.',
];

const dec = (v: { toString(): string } | null | undefined): string => (v ? v.toString() : '0');

/** Reduce a width:height to a simple ratio label via GCD (e.g. 1920×1080 → "16:9"). */
const aspectRatioLabel = (w?: number | null, h?: number | null): string | null => {
  if (!w || !h) return null;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
};

export interface ScreenDescription {
  screenId: string;
  type: 'led' | 'lcd';
  description: string;
}

export const buildDescriptions = (
  quote: QuoteWithChildren,
  ratios?: readonly ScreenRatioRow[],
): ScreenDescription[] => {
  const ratioFor = (w?: number | null, h?: number | null): string | null =>
    (ratios && w && h ? resolveScreenRatio(w, h, ratios) : null) ?? aspectRatioLabel(w, h);
  const out: ScreenDescription[] = [];
  for (const s of quote.ledScreens) {
    out.push({
      screenId: s.id.toString(),
      type: 'led',
      description: describeLedScreen({
        productModel: s.ledProduct?.model ?? s.screenName,
        widthMm: s.desiredWidthMm,
        heightMm: s.desiredHeightMm,
        ratioLabel: ratioFor(s.desiredWidthMm, s.desiredHeightMm),
        pixelPitchMm: s.ledProduct?.pixelPitchH ? Number(s.ledProduct.pixelPitchH) : null,
        resolutionWpx: s.resolutionWpx,
        resolutionHpx: s.resolutionHpx,
        serviceAccess: s.serviceAccess ?? s.ledProduct?.serviceAccess ?? null,
        warrantyName: s.warranty?.name ?? null,
        locationName: quote.location?.name ?? null,
        qty: s.qty,
      }),
    });
  }
  for (const s of quote.lcdScreens) {
    out.push({
      screenId: s.id.toString(),
      type: 'lcd',
      description: describeLcdScreen({
        model: s.display?.model ?? s.screenName,
        warrantyName: s.warranty?.name ?? null,
        locationName: quote.location?.name ?? null,
        orientation: (s.orientation as 'L' | 'P' | null) ?? null,
        externalMediaplayers: lcdExternalMediaplayers(s),
        componentDescriptions: lcdComponentDescriptions(s),
      }),
    });
  }
  return out;
};

type LcdScreen = QuoteWithChildren['lcdScreens'][number];

/** Item description or its catalog model, for LCD narrative building. */
const lcdItemLabel = (i: LcdScreen['items'][number]): string =>
  (i.description ?? i.display?.model ?? '').trim();

/** External `mediaplayer` item descriptions (qty>0) — empty → the in-built SeenCMP mediaplayer (tab B2). */
const lcdExternalMediaplayers = (s: LcdScreen): string[] =>
  s.items
    .filter((i) => i.itemType === 'mediaplayer' && Number(i.qty) > 0)
    .map(lcdItemLabel)
    .filter((d) => d.length > 0);

/** Bracket + install item descriptions worth surfacing in the LCD description (tab B2). */
const lcdComponentDescriptions = (s: LcdScreen): string[] =>
  s.items
    .filter((i) => (i.itemType === 'bracket' || i.itemType === 'install') && Number(i.qty) > 0)
    .map(lcdItemLabel)
    .filter((d) => d.length > 0);

/** Order list (tab B56): "N x <display>, N x <bracket>, …" from the screen's display + bracket items. */
export const lcdOrderList = (s: LcdScreen): string =>
  buildLcdOrderList(
    s.items
      .filter((i) => i.itemType === 'display' || i.itemType === 'bracket')
      .map((i) => ({ name: lcdItemLabel(i), qty: Number(i.qty) })),
  );

export interface BomComponent {
  type: string;
  name: string;
  qty: number;
  unitCost: string | null;
  unitSell: string | null;
}
export interface BomScreen {
  screenId: string;
  description: string;
  components: BomComponent[];
  costLines: Array<{ label: string; category: string | null; cost: string | null; sell: string | null }>;
}

const componentName = (c: QuoteWithChildren['ledScreens'][number]['components'][number]): string =>
  c.controller?.name ??
  c.mediaplayer?.name ??
  c.ledPeripheral?.name ??
  c.peripheral?.name ??
  c.componentType;

/** Procurement-ready BOM/PI (P1-18.3): every auto-included item per screen. */
export const buildBom = (
  quote: QuoteWithChildren,
  showCost: boolean,
  ratios?: readonly ScreenRatioRow[],
): BomScreen[] => {
  const descriptions = new Map(buildDescriptions(quote, ratios).map((d) => [d.screenId, d.description]));
  return quote.ledScreens.map((s) => ({
    screenId: s.id.toString(),
    description: descriptions.get(s.id.toString()) ?? (s.screenName ?? 'LED screen'),
    components: [
      ...(s.ledProduct ? [{ type: 'led_panel', name: s.ledProduct.model, qty: s.qty, unitCost: null, unitSell: null }] : []),
      ...(s.frame ? [{ type: 'frame', name: s.frame.name, qty: 1, unitCost: showCost ? dec(s.frame.price) : null, unitSell: null }] : []),
      ...(s.gob ? [{ type: 'gob', name: s.gob.name, qty: 1, unitCost: null, unitSell: null }] : []),
      ...s.components.map((c) => ({
        type: c.componentType,
        name: componentName(c),
        qty: c.qty,
        unitCost: showCost ? dec(c.unitCostSnapshot) : null,
        unitSell: dec(c.unitSellSnapshot),
      })),
    ],
    costLines: s.costBreakdown.map((l) => ({
      label: l.lineLabel,
      category: l.category,
      cost: showCost ? dec(l.cost) : null,
      sell: dec(l.sell),
    })),
  }));
};

/** Internal "what was quoted and why" (P1-18.4). */
export const buildSolutionSummary = (quote: QuoteWithChildren, showCost: boolean) => ({
  jobReference: quote.jobReference,
  client: quote.client?.name ?? null,
  location: quote.location?.name ?? null,
  currency: quote.currency?.code ?? 'AUD',
  screens: quote.ledScreens.map((s) => ({
    name: s.screenName,
    product: s.ledProduct?.model ?? null,
    dimensionsMm: s.desiredWidthMm && s.desiredHeightMm ? `${s.desiredWidthMm} x ${s.desiredHeightMm}` : null,
    resolution: s.resolutionWpx && s.resolutionHpx ? `${s.resolutionWpx} x ${s.resolutionHpx}px` : null,
    weightKg: dec(s.weightKg),
    labourHours: dec(s.labourHours),
    installMethod: s.installMethod?.name ?? null,
    priceTotal: dec(s.priceTotal),
    costTotal: showCost ? dec(s.priceScreenMediaplayer) : null,
  })),
  lcdScreens: quote.lcdScreens.map((s) => ({
    name: s.screenName,
    display: s.display?.model ?? null,
    orientation: s.orientation ?? null,
    priceTotal: dec(s.priceTotal),
    costTotal: showCost ? dec(s.priceScreenMediaplayer) : null,
    // Order list (tab B56): what to procure for this display.
    orderList: lcdOrderList(s),
  })),
  totals: {
    equipment: dec(quote.totalEquipment),
    services: dec(quote.totalServices),
    recurring: dec(quote.totalRecurring),
    grandTotal: dec(quote.grandTotal),
  },
  assumptions: DEFAULT_ASSUMPTIONS,
  exclusions: DEFAULT_EXCLUSIONS,
});

/** Risk severity ordering for grouped/sorted display (high → low). T4. */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Manual risks sorted by severity (high first), then capture order. Shared by the PDF + PM handoff. */
export const sortedRisks = (quote: QuoteWithChildren) =>
  [...quote.risks].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.seq - b.seq,
  );

/**
 * Site context (AA1): the one-per-quote intake/PI fields from the workshop intake questionnaire.
 * Defensive — only the fields that are set are surfaced (nulls omitted). Returns `null` when none
 * of them are populated, so the PM handoff can omit the section entirely.
 */
const buildSiteContext = (quote: QuoteWithChildren): Record<string, string> | null => {
  const ctx: Record<string, string> = {};
  if (quote.endCustomer) ctx.endCustomer = quote.endCustomer;
  if (quote.siteAddress) ctx.siteAddress = quote.siteAddress;
  if (quote.airsideLandside) ctx.airsideLandside = quote.airsideLandside;
  if (quote.sunExposure) ctx.sunExposure = quote.sunExposure;
  if (quote.wallSubstrate) ctx.wallSubstrate = quote.wallSubstrate;
  if (quote.powerDataAvailable) ctx.powerDataAvailable = quote.powerDataAvailable;
  if (quote.controllerLocation) ctx.controllerLocation = quote.controllerLocation;
  if (quote.windowFacing != null) ctx.windowFacing = quote.windowFacing ? 'Yes' : 'No';
  return Object.keys(ctx).length > 0 ? ctx : null;
};

/** PM handoff (P1-18.5): execution-focused subset of the approved quote. */
export const buildPmHandoff = (quote: QuoteWithChildren) => ({
  jobReference: quote.jobReference,
  client: quote.client?.name ?? null,
  location: quote.location?.name ?? null,
  status: quote.status,
  // Site context (AA1): intake/PI site details; omitted when none are captured.
  siteContext: buildSiteContext(quote),
  // Assumptions & risks register (T4): assumptions reuse terms (kind=assumption); risks are manual.
  assumptions: quote.terms.filter((t) => t.kind === 'assumption').map((t) => t.text),
  risks: sortedRisks(quote).map((r) => ({
    category: r.category,
    severity: r.severity,
    description: r.description,
    mitigation: r.mitigation,
  })),
  screens: quote.ledScreens.map((s) => ({
    name: s.screenName,
    product: s.ledProduct?.model ?? null,
    dimensionsMm: s.desiredWidthMm && s.desiredHeightMm ? `${s.desiredWidthMm} x ${s.desiredHeightMm}` : null,
    weightKg: dec(s.weightKg),
    powerMaxW: s.powerMaxW,
    labourHours: dec(s.labourHours),
    installMethod: s.installMethod?.name ?? null,
    serviceAccess: s.serviceAccess ?? null,
    // AA1 — recess/cavity depth (mm); omitted (null) when not captured.
    recessDepthMm: s.recessDepthMm ?? null,
    // AA2 — content authoring + flatness notes (null/false when not captured).
    contentRatio: s.contentRatio ?? null,
    contentSupplier: s.contentSupplier ?? null,
    flatnessRequired: s.flatnessRequired ?? null,
    componentsToProcure: s.components.map((c) => ({ name: componentName(c), qty: c.qty })),
  })),
  lcdScreens: quote.lcdScreens.map((s) => ({
    name: s.screenName,
    display: s.display?.model ?? null,
    orientation: s.orientation ?? null,
    // AA1 — recess/cavity depth (mm); omitted (null) when not captured.
    recessDepthMm: s.recessDepthMm ?? null,
    // Order list (tab B56): the display + brackets the PM procures for this screen.
    orderList: lcdOrderList(s),
  })),
});
