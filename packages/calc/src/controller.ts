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
  /** Output ports (controllers.max_ports); null/absent → ports are not checked for this unit. */
  maxPorts?: number | null;
  /** Controller family (controllers.type), e.g. "Standard", "Card Only (MSD300)". */
  type?: string | null;
}

/** Optional workbook rules for {@link selectController}. Omit both → pixel-capacity-only selection. */
export interface ControllerSelectOptions {
  /** Ports the screen needs (see {@link controllerPortsNeeded}); units with fewer ports are skipped. */
  portsNeeded?: number;
  /** Prefer this controller type when one covers the screen (workbook default: "Standard"). */
  preferType?: string;
}

/** Pixels one controller port drives — workbook `(LED 1)` H248 (`/650000`). */
export const PIXELS_PER_PORT = 650_000;

/**
 * Ports a screen needs — workbook `(LED 1)` H248:
 *   WALL products (model "… / WALL…"): MAX(⌈width m⌉, ⌈pixels / 650 000⌉) — one port per metre of width;
 *   everything else:                   ⌈pixels / 650 000⌉.
 * e.g. WALL-PRO2.5 1500 mm wide, 480 000 px → MAX(2, 1) = 2 ports.
 */
export const controllerPortsNeeded = (input: { model: string; widthMm: number; pixels: number }): number => {
  const byPixels = Math.ceil(input.pixels / PIXELS_PER_PORT);
  // The workbook tests RIGHT(LEFT(model, 13), 4) = "WALL", i.e. the "IAF250 / WALL…" naming.
  const isWall = /\/\s*WALL/i.test(input.model);
  return isWall ? Math.max(Math.ceil(input.widthMm / 1000), byPixels) : byPixels;
};

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
  opts: ControllerSelectOptions = {},
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

  // Candidates whose single-unit capacity covers the pixels (inclusive: capacity == pixels is a fit)
  // and, when the screen's port count is known, that have enough ports (unknown ports → not checked).
  const ports = opts.portsNeeded ?? 0;
  const covering = usable.filter(
    (c) => c.maxPixels >= pixels && (ports <= 0 || c.maxPorts == null || c.maxPorts >= ports),
  );
  // Workbook default controller type ("Standard" → MCTRL300 / MCTRL700): prefer it when one fits.
  const preferred = opts.preferType
    ? covering.filter((c) => (c.type ?? '').trim().toLowerCase() === opts.preferType!.trim().toLowerCase())
    : [];
  const sufficient = preferred.length > 0 ? preferred : covering;

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

  // ── Enough pixel capacity but not enough ports on any single unit → multiple of the most-ported unit. ──
  const pixelOk = usable.filter((c) => c.maxPixels >= pixels && c.maxPorts != null && c.maxPorts > 0);
  if (ports > 0 && pixelOk.length > 0) {
    const most = pixelOk.reduce((best, c) => ((c.maxPorts ?? 0) > (best.maxPorts ?? 0) ? c : best), pixelOk[0]!);
    const count = Math.ceil(ports / (most.maxPorts ?? 1));
    return {
      controller: null,
      multiControllerCount: count,
      needsMultiController: true,
      reason: `The screen needs ${ports} ports, more than any single controller has (${most.maxPorts}). Recommend ${count}× "${most.name}" controllers.`,
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
