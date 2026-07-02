import {
  canFinalise,
  resolveScreenRatio,
  validateScreen,
  validateLcdScreen,
  type ScreenRatioRow,
  type ValidationFinding,
  type ValidationInput,
  type LcdValidationInput,
} from '@quotezen/calc';
import { getQuote } from './service.js';
import { loadRatios } from './outputs.js';
import { evaluateAnomalies, type AnomalyFinding } from './anomaly.js';
import { evaluateCommercialAdvisories } from './advisories.js';
import type { QuoteWithChildren } from './repository.js';

/**
 * Conflict / validation engine exposure (P1-15.1/.2/.3).
 *
 * Maps each persisted quote screen to the calc `validateScreen` input — using the SAME FK/spec
 * fields `addLedScreen` reads when pricing — runs the deterministic rule engine, and aggregates
 * the findings. Pure derivation over the loaded quote; nothing is stored (validation is computed).
 */

export interface ScreenValidation {
  screenId: string;
  screenName: string;
  findings: Array<ValidationFinding & { field?: string }>;
}

export interface QuoteValidation {
  quoteId: string;
  canFinalise: boolean;
  counts: { error: number; warning: number; cannotEvaluate: number };
  screens: ScreenValidation[];
  /**
   * Z4 — configurable anomaly-rule findings (quote-level; some carry a `screenId`). Folded into
   * `counts` and `canFinalise` alongside the per-screen findings — a 'block' rule ('error') gates
   * finalisation just like a per-screen error.
   */
  anomalies: AnomalyFinding[];
}

/** Context threaded into per-screen validation for the AA2 client-scoped rules. */
interface LedValidationContext {
  ratios: ScreenRatioRow[];
  allowedRatios: string[];
  clientPreferredPitchMm: number | null;
}

/**
 * The achieved aspect-ratio label of a stored screen (AA2). Prefers the built pixel grid
 * (resolutionWpx/Hpx), falling back to the desired opening dims; null when neither is available.
 */
const achievedRatioLabel = (
  screen: QuoteWithChildren['ledScreens'][number],
  ratios: ScreenRatioRow[],
): string | null => {
  const w = screen.resolutionWpx ?? screen.desiredWidthMm ?? null;
  const h = screen.resolutionHpx ?? screen.desiredHeightMm ?? null;
  if (w == null || h == null || h <= 0) return null;
  return resolveScreenRatio(w, h, ratios);
};

/** Build the calc validation input for one stored LED screen from its loaded relations. */
const ledScreenToInput = (
  screen: QuoteWithChildren['ledScreens'][number],
  ctx: LedValidationContext,
): ValidationInput => {
  // The most capable selected controller governs the pixel-capacity check.
  const controllers = screen.components.filter((c) => c.controller);
  const controllerSelected = controllers.length > 0;
  const controllerMaxPixels = controllers.reduce<number | null>((max, c) => {
    const cap = c.controller?.maxPixels != null ? Number(c.controller.maxPixels) : null;
    if (cap == null) return max;
    return max == null ? cap : Math.max(max, cap);
  }, null);

  const pitch = screen.ledProduct?.pixelPitchH != null ? Number(screen.ledProduct.pixelPitchH) : null;

  // AA2 — compatibility groups: screen product, selected controllers, and the frame/bracket.
  const controllerCompatibilityGroups = controllers
    .map((c) => c.controller?.compatibilityGroup ?? null)
    .filter((g): g is string => g != null && g !== '');

  const achieved = achievedRatioLabel(screen, ctx.ratios);

  return {
    pixelPitchMm: pitch,
    gobSelected: screen.gobId != null,
    totalPixels: screen.totalPixels != null ? Number(screen.totalPixels) : null,
    controllerSelected,
    controllerMaxPixels,
    widthMm: screen.desiredWidthMm ?? null,
    heightMm: screen.desiredHeightMm ?? null,
    // Environment / orientation / outdoor deps are not captured per-screen in this prototype, so
    // those rules naturally fall to cannot_evaluate / non-applicable — never a false error.
    // ── AA2 ──
    achievedRatioLabel: achieved,
    allowedRatios: ctx.allowedRatios,
    productCompatibilityGroup: screen.ledProduct?.compatibilityGroup ?? null,
    controllerCompatibilityGroups,
    frameCompatibilityGroup: screen.frame?.compatibilityGroup ?? null,
    clientPreferredPitchMm: ctx.clientPreferredPitchMm,
    contentRatioLabel: screen.contentRatio ?? null,
  };
};

/** Build the calc validation input for one stored LCD screen from its loaded items. */
const lcdScreenToInput = (
  screen: QuoteWithChildren['lcdScreens'][number],
): LcdValidationInput => {
  // AA3a — the chosen display row (the screen's `display` relation, else the display line item's join).
  // Its brand/android/depth/size feed the depth + Android checks; null on any of these keeps the rule
  // at cannot_evaluate / no-finding (never a false warning).
  const displayItem = screen.items.find((i) => i.itemType === 'display' && i.display != null);
  const chosenDisplay = screen.display ?? displayItem?.display ?? null;
  const numOrNull = (v: { toString(): string } | null | undefined): number | null =>
    v != null ? Number(v.toString()) : null;

  return {
    orientation: screen.orientation ?? null,
    // AA3a — chosen-display characteristics.
    displayBrand: chosenDisplay?.brand ?? null,
    displayBuiltInAndroid: chosenDisplay?.builtInAndroid ?? null,
    displayDepthMm: chosenDisplay?.depthMm ?? null,
    displaySizeIn: numOrNull(chosenDisplay?.sizeInch),
    // AA3a — site requirement fields.
    maxDepthMm: screen.maxDepthMm ?? null,
    requiresAndroid: screen.requiresAndroid ?? null,
    needsPc: screen.needsPc ?? null,
    needsHardDrive: screen.needsHardDrive ?? null,
    items: screen.items.map((i) => ({
      itemType: i.itemType,
      displayId: i.displayId != null ? i.displayId.toString() : null,
      // `addLcdScreen` snapshots the display's model into `description`; fall back to the joined
      // display model when present. If neither is available the built-in-player check stays
      // cannot_evaluate — never a false warning.
      description: i.description ?? i.display?.model ?? null,
      // AA3a — bracket-row constraints from the bracket item's linked catalog row (null → checks skip).
      bracketMinSizeIn: i.itemType === 'bracket' ? (i.display?.minSizeIn ?? null) : null,
      bracketMaxSizeIn: i.itemType === 'bracket' ? (i.display?.maxSizeIn ?? null) : null,
      bracketPortraitCapable: i.itemType === 'bracket' ? (i.display?.portraitCapable ?? null) : null,
    })),
  };
};

export const validateQuote = async (id: bigint): Promise<QuoteValidation> => {
  const quote = await getQuote(id);

  // AA2 — client-scoped context: the ratio lookup, the client's allowed ratios, and preferred pitch.
  const ratios = await loadRatios();
  const ledCtx: LedValidationContext = {
    ratios,
    allowedRatios: (quote.client?.allowedRatios ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
    clientPreferredPitchMm:
      quote.client?.preferredPitchMm != null ? Number(quote.client.preferredPitchMm) : null,
  };

  const ledScreens: ScreenValidation[] = quote.ledScreens.map((s) => ({
    screenId: s.id.toString(),
    screenName: s.screenName ?? 'LED screen',
    findings: validateScreen(ledScreenToInput(s, ledCtx)),
  }));

  const lcdScreens: ScreenValidation[] = quote.lcdScreens.map((s) => ({
    screenId: s.id.toString(),
    screenName: s.screenName ?? 'LCD screen',
    findings: validateLcdScreen(lcdScreenToInput(s)),
  }));

  const screens = [...ledScreens, ...lcdScreens];

  // Z4 — configurable anomaly rules (DB-driven; disabled rules produce nothing). Their severity is
  // already 'error' | 'warning' (block → error, warn → warning), so they fold into the same tallies.
  // AA6a — commercial-intake advisories (solutions-engineer review + freight-mode). Always warning/
  // info, NEVER blocking; concatenated into the same `anomalies` list so the Review card renders them.
  const [z4Anomalies, advisories] = await Promise.all([
    evaluateAnomalies(quote),
    evaluateCommercialAdvisories(quote),
  ]);
  const anomalies = [...z4Anomalies, ...advisories];

  const screenFindings = screens.flatMap((s) => s.findings);
  const counts = {
    error:
      screenFindings.filter((f) => f.severity === 'error').length +
      anomalies.filter((a) => a.severity === 'error').length,
    warning:
      screenFindings.filter((f) => f.severity === 'warning').length +
      anomalies.filter((a) => a.severity === 'warning').length,
    cannotEvaluate: screenFindings.filter((f) => f.severity === 'cannot_evaluate').length,
  };

  // canFinalise = no error-severity finding across BOTH per-screen findings AND anomalies.
  const noAnomalyErrors = !anomalies.some((a) => a.severity === 'error');

  return {
    quoteId: quote.id.toString(),
    canFinalise: canFinalise(screenFindings) && noAnomalyErrors,
    counts,
    screens,
    anomalies,
  };
};

/** Collect every error-severity per-screen finding across a quote. */
export const collectScreenErrors = (validation: QuoteValidation): ValidationFinding[] =>
  validation.screens.flatMap((s) => s.findings.filter((f) => f.severity === 'error'));

/**
 * Collect every error-severity finding that gates finalisation — per-screen errors AND anomaly BLOCK
 * ('error') findings (Z4). Each is normalised to `{ rule, message }`; used by `changeStatus` so the
 * validation guardrail gates on anomalies too.
 */
export const collectAllErrors = (validation: QuoteValidation): Array<{ rule: string; message: string }> => [
  ...collectScreenErrors(validation).map((f) => ({ rule: f.rule, message: f.message })),
  ...validation.anomalies.filter((a) => a.severity === 'error').map((a) => ({ rule: a.rule, message: a.message })),
];
