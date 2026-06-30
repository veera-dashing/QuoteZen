import {
  canFinalise,
  validateScreen,
  type ValidationFinding,
  type ValidationInput,
} from '@quotezen/calc';
import { getQuote } from './service.js';
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
}

/** Build the calc validation input for one stored LED screen from its loaded relations. */
const ledScreenToInput = (
  screen: QuoteWithChildren['ledScreens'][number],
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
  };
};

export const validateQuote = async (id: bigint): Promise<QuoteValidation> => {
  const quote = await getQuote(id);

  const screens: ScreenValidation[] = quote.ledScreens.map((s) => ({
    screenId: s.id.toString(),
    screenName: s.screenName ?? 'LED screen',
    findings: validateScreen(ledScreenToInput(s)),
  }));

  const all = screens.flatMap((s) => s.findings);
  const counts = {
    error: all.filter((f) => f.severity === 'error').length,
    warning: all.filter((f) => f.severity === 'warning').length,
    cannotEvaluate: all.filter((f) => f.severity === 'cannot_evaluate').length,
  };

  return {
    quoteId: quote.id.toString(),
    canFinalise: canFinalise(all),
    counts,
    screens,
  };
};

/** Collect every error-severity finding across a quote — used to gate finalisation server-side. */
export const collectScreenErrors = (validation: QuoteValidation): ValidationFinding[] =>
  validation.screens.flatMap((s) => s.findings.filter((f) => f.severity === 'error'));
