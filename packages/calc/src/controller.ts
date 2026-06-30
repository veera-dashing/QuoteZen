/**
 * Controller auto-selection (P1-09.3 / P1-09.4).
 *
 * Each LED controller has a maximum pixel load capacity. Given a screen's total pixel count
 * (width_px × height_px), pick the smallest/cheapest controller whose capacity covers the pixels —
 * the deterministic equivalent of the workbook's IFS/VLOOKUP (pixel-count threshold → controller).
 *
 * If the pixel count exceeds the largest single controller's capacity we do NOT error: we recommend a
 * multi-controller solution (count = ceil(pixels / largest capacity)) and flag it. Pure and
 * deterministic — same inputs always yield the same result, with stable, explainable tiebreaks
 * (mirrors the ranking style in config.ts).
 *
 * Calc-spec → DB mapping (`model Controller` in packages/db/prisma/schema.prisma):
 *   ControllerSpec.id       → controllers.id
 *   ControllerSpec.name     → controllers.name
 *   ControllerSpec.maxPixels→ controllers.max_pixels  (BigInt load capacity; kept `number` here so calc
 *                              stays DB-free — callers convert the BigInt before invoking)
 *   ControllerSpec.cost     → controllers.price        (Decimal; optional, used only as a tiebreak)
 */
export interface ControllerSpec {
  id: string | number;
  name: string;
  /** Maximum pixel load capacity (controllers.max_pixels). */
  maxPixels: number;
  /** Unit cost (controllers.price); optional — used only as a tiebreak. */
  cost?: number | null;
}

export interface ControllerSelection {
  /** The chosen controller, or null when no single controller covers the pixels. */
  controller: ControllerSpec | null;
  /** Number of controllers required (1 for a single-controller fit). */
  multiControllerCount: number;
  /** True when the pixel count exceeds the largest single controller's capacity. */
  needsMultiController: boolean;
  /** Populated when no clean single fit is possible (degenerate input, empty list, or over-capacity). */
  reason: string | null;
}

/** Controllers usable for selection — positive, finite capacity only. */
const usableControllers = (controllers: readonly ControllerSpec[]): ControllerSpec[] =>
  controllers.filter((c) => Number.isFinite(c.maxPixels) && c.maxPixels > 0);

export const selectController = (
  pixels: number,
  controllers: readonly ControllerSpec[],
): ControllerSelection => {
  // ── Degenerate pixel count ──
  if (!Number.isFinite(pixels) || pixels <= 0) {
    return {
      controller: null,
      multiControllerCount: 0,
      needsMultiController: false,
      reason: 'Pixel count must be a positive number to select a controller.',
    };
  }

  const usable = usableControllers(controllers);
  if (usable.length === 0) {
    return {
      controller: null,
      multiControllerCount: 0,
      needsMultiController: false,
      reason: 'No controllers with a valid pixel capacity are available.',
    };
  }

  // Candidates whose single-unit capacity covers the pixels (inclusive: capacity == pixels is a fit).
  const sufficient = usable.filter((c) => c.maxPixels >= pixels);

  if (sufficient.length > 0) {
    // Smallest sufficient capacity, then lowest cost, then name — stable, explainable tiebreak.
    sufficient.sort((a, b) => {
      if (a.maxPixels !== b.maxPixels) return a.maxPixels - b.maxPixels;
      const ca = a.cost ?? Number.POSITIVE_INFINITY;
      const cb = b.cost ?? Number.POSITIVE_INFINITY;
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name);
    });
    return {
      controller: sufficient[0]!,
      multiControllerCount: 1,
      needsMultiController: false,
      reason: null,
    };
  }

  // ── Over-capacity → recommend a multi-controller solution (flag, don't error). ──
  const largest = usable.reduce((best, c) => (c.maxPixels > best.maxPixels ? c : best), usable[0]!);
  const count = Math.ceil(pixels / largest.maxPixels);
  return {
    controller: null,
    multiControllerCount: count,
    needsMultiController: true,
    reason: `Pixel count (${pixels}) exceeds the largest controller capacity (${largest.maxPixels}). Recommend ${count}× "${largest.name}" controllers.`,
  };
};
