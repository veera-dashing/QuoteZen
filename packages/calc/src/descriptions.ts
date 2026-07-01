/**
 * Deterministic auto-description templates (P1-18.1).
 *
 * Pure string builders — no AI, no randomness — so the narrative always matches the committed
 * configuration (BR-093). Callers pass already-resolved values (product model, ratio label, etc.).
 */
export interface LedScreenDescriptionParts {
  productModel?: string | null;
  widthMm?: number | null;
  heightMm?: number | null;
  ratioLabel?: string | null;
  pixelPitchMm?: number | null;
  resolutionWpx?: number | null;
  resolutionHpx?: number | null;
  serviceAccess?: string | null;
  warrantyName?: string | null;
  locationName?: string | null;
  qty?: number;
}

const joinClauses = (clauses: Array<string | null | undefined>): string =>
  clauses.filter((c): c is string => Boolean(c && c.trim())).join(', ');

export const describeLedScreen = (p: LedScreenDescriptionParts): string => {
  const dims = p.widthMm && p.heightMm ? `${p.widthMm} x ${p.heightMm}mm` : null;
  const resolution =
    p.resolutionWpx && p.resolutionHpx
      ? `${p.resolutionWpx} x ${p.resolutionHpx}px (${(p.resolutionWpx * p.resolutionHpx).toLocaleString('en-AU')}px)`
      : null;
  const pitch = p.pixelPitchMm ? `${p.pixelPitchMm}mm pitch` : null;
  const head = `Seen ${p.productModel ?? 'LED'} LED Screen`;
  const qtyPrefix = p.qty && p.qty > 1 ? `${p.qty} x ` : '';
  const body = joinClauses([
    dims,
    p.ratioLabel ? `${p.ratioLabel} ratio` : null,
    pitch,
    resolution,
    p.serviceAccess ? `${p.serviceAccess} service` : null,
    p.warrantyName,
    p.locationName,
  ]);
  return body ? `${qtyPrefix}${head} (${body})` : `${qtyPrefix}${head}`;
};

export interface LcdScreenDescriptionParts {
  model?: string | null;
  warrantyName?: string | null;
  locationName?: string | null;
  qty?: number;
  /** Orientation of the display — 'L' (Landscape) / 'P' (Portrait). */
  orientation?: 'L' | 'P' | null;
  /** Descriptions of external `mediaplayer` items (qty>0). Empty → the in-built SeenCMP mediaplayer. */
  externalMediaplayers?: string[];
  /** Additional component descriptions worth surfacing (bracket + install items). */
  componentDescriptions?: string[];
}

/**
 * Deterministic LCD service description (tab B2). Composes: model head → mediaplayer clause (external
 * players joined, else the in-built SeenCMP default) → any surfaced component descriptions → an
 * orientation suffix (Landscape/Portrait) → an optional warranty clause. Comma-separated, stable.
 */
export const describeLcdScreen = (p: LcdScreenDescriptionParts): string => {
  const qtyPrefix = p.qty && p.qty > 1 ? `${p.qty} x ` : '';
  const head = p.model ?? 'LCD display';
  const externals = (p.externalMediaplayers ?? []).filter((m) => m && m.trim());
  const mediaplayerClause =
    externals.length > 0 ? externals.join(', ') : 'in-built SeenCMP mediaplayer';
  const orientationSuffix =
    p.orientation === 'L' ? ' (Landscape)' : p.orientation === 'P' ? ' (Portrait)' : '';
  const body = joinClauses([
    mediaplayerClause,
    ...(p.componentDescriptions ?? []),
    p.warrantyName,
  ]);
  const withBody = body ? `${head} with ${body}` : head;
  return `${qtyPrefix}${withBody}${orientationSuffix}`;
};

/** One entry in an LCD screen's order list (tab B56) — a qty'd catalog line worth procuring. */
export interface OrderListEntry {
  name: string;
  qty: number;
}

/**
 * Deterministic "order list" string for an LCD screen (tab B56) — `"N x <display>, N x <bracket>, …"`,
 * built from the screen's display + bracket items (qty>0), in the order supplied. Empty entries skipped.
 */
export const buildLcdOrderList = (entries: readonly OrderListEntry[]): string =>
  entries
    .filter((e) => e.name && e.name.trim() && e.qty > 0)
    .map((e) => `${e.qty} x ${e.name.trim()}`)
    .join(', ');
