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
}

export const describeLcdScreen = (p: LcdScreenDescriptionParts): string => {
  const qtyPrefix = p.qty && p.qty > 1 ? `${p.qty} x ` : '';
  const body = joinClauses([p.warrantyName, p.locationName]);
  return body ? `${qtyPrefix}${p.model ?? 'LCD display'} (${body})` : `${qtyPrefix}${p.model ?? 'LCD display'}`;
};
