import { describe, expect, it } from 'vitest';
import { configureScreen, selectTiers, type ConfigProduct } from './config.js';
import type { ScreenRatioRow } from './geometry.js';

const RATIOS: ScreenRatioRow[] = [
  { minValue: 1.69, maxValue: 1.88, ratioLabel: '16:9' },
  { minValue: 0.54, maxValue: 0.59, ratioLabel: '9:16' },
  { minValue: 0.91, maxValue: 1.12, ratioLabel: '1:1' },
];

const PRODUCTS: ConfigProduct[] = [
  { id: 1, model: 'OSD320 / OF1.8', minCabinetWMm: 320, minCabinetHMm: 160, pixelPitchHmm: 1.86, pixelPitchVmm: 1.86 },
  { id: 2, model: 'ISD500 / IF2.6', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6 },
  { id: 3, model: 'NoData', minCabinetWMm: 0, minCabinetHMm: 0, pixelPitchHmm: 0, pixelPitchVmm: 0 },
];

describe('configureScreen', () => {
  it('returns ranked options and excludes products without complete data', () => {
    const res = configureScreen(PRODUCTS, { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS });
    expect(res.reasons).toEqual([]);
    expect(res.options.length).toBeGreaterThan(0);
    // product 3 (no cabinet/pitch data) must be excluded
    expect(res.options.some((o) => o.model === 'NoData')).toBe(false);
    // ranked by closest area fit — first option's area deviation <= last
    const first = res.options[0]!;
    expect(first.fillPercent.toNumber()).toBeGreaterThan(0);
  });

  it('computes fill %, resolution and ratio for a fit', () => {
    const res = configureScreen([PRODUCTS[1]!], {
      desiredWidthMm: 1000,
      desiredHeightMm: 1000,
      ratios: RATIOS,
    });
    const opt = res.options[0]!;
    // 1000/500 = 2 cabinets each way → exact 1000×1000
    expect(opt.widthMm).toBe(1000);
    expect(opt.heightMm).toBe(1000);
    expect(opt.cabinetCount).toBe(4);
    expect(opt.fillPercent.toString()).toBe('100');
    expect(opt.ratioLabel).toBe('1:1');
    // 1000/2.6 ≈ 385 px
    expect(opt.resolutionWpx).toBe(385);
    expect(opt.cutCabinetSuggested).toBe(false);
  });

  it('flags a cut cabinet when the opening is far from a whole-cabinet multiple', () => {
    // 1100 wide on a 500 cabinet → snaps to 1000 (2 cab), remainder 100/500 = 0.2 <0.25 → no cut
    // 1200 wide → snaps to 1000, remainder 200/500 = 0.4 >0.25 → cut suggested
    const res = configureScreen([PRODUCTS[1]!], {
      desiredWidthMm: 1200,
      desiredHeightMm: 1000,
      ratios: RATIOS,
    });
    expect(res.options[0]!.cutCabinetSuggested).toBe(true);
  });

  it('dedupes rotation of a square cabinet (no rotated duplicate)', () => {
    const res = configureScreen([PRODUCTS[1]!], {
      desiredWidthMm: 1000,
      desiredHeightMm: 1500,
      ratios: RATIOS,
    });
    // square 500×500 cabinet → rotation produces identical geometry, deduped to one
    expect(res.options.length).toBe(1);
  });

  it('offers a rotated option for non-square cabinets when geometry differs', () => {
    // 320×160 cabinet at 400×400: non-rotated → 320×480, rotated → 480×320 (distinct → two options)
    const res = configureScreen([PRODUCTS[0]!], {
      desiredWidthMm: 400,
      desiredHeightMm: 400,
      ratios: RATIOS,
    });
    expect(res.options.some((o) => o.rotated)).toBe(true);
    expect(res.options.some((o) => !o.rotated)).toBe(true);
  });

  it('returns empty-with-reasons (never throws) for a zero opening', () => {
    const res = configureScreen(PRODUCTS, { desiredWidthMm: 0, desiredHeightMm: 1000, ratios: RATIOS });
    expect(res.options).toEqual([]);
    expect(res.reasons[0]).toMatch(/greater than zero/);
  });

  it('returns reasons when no product has usable data', () => {
    const res = configureScreen([PRODUCTS[2]!], { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS });
    expect(res.options).toEqual([]);
    expect(res.reasons[0]).toMatch(/complete cabinet/);
  });
});

describe('selectTiers (Good/Better/Best — T2)', () => {
  // Three distinct products. "Mid" snaps to an EXACT 1000×1000 fit (500mm cabinets) so it is
  // unambiguously best-fit (recommended); the other two snap to a worse fit, leaving cost/pitch
  // to drive value/premium.
  const TIER_PRODUCTS: ConfigProduct[] = [
    // cheap, coarse pitch, 400mm cabinet → snaps to 1200×1200 (worse fit) → should win VALUE
    { id: 10, model: 'Cheap', minCabinetWMm: 400, minCabinetHMm: 400, pixelPitchHmm: 4, pixelPitchVmm: 4, costPerSqmUsd: 100, brightnessNits: 800 },
    // mid cost/pitch, 500mm cabinet → exact 1000×1000 fit → RECOMMENDED (best fit)
    { id: 11, model: 'Mid', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6, costPerSqmUsd: 300, brightnessNits: 1200 },
    // expensive, fine pitch, 400mm cabinet → snaps to 1200×1200 (worse fit) → should win PREMIUM
    { id: 12, model: 'Fine', minCabinetWMm: 400, minCabinetHMm: 400, pixelPitchHmm: 1.2, pixelPitchVmm: 1.2, costPerSqmUsd: 900, brightnessNits: 2000 },
  ];

  const lookupOf = (products: ConfigProduct[]) => ({
    costPerSqm: new Map(products.map((p) => [String(p.id), p.costPerSqmUsd ?? Infinity])),
    pixelPitchMm: new Map(products.map((p) => [String(p.id), p.pixelPitchHmm])),
    brightnessNits: new Map(products.map((p) => [String(p.id), p.brightnessNits ?? 0])),
  });

  it('picks value=cheapest, recommended=best-fit, premium=finest pitch, all distinct', () => {
    const ranked = configureScreen(TIER_PRODUCTS, { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS }).options;
    const sel = selectTiers(ranked, lookupOf(TIER_PRODUCTS));
    const byTier = Object.fromEntries(sel.picks.map((p) => [p.tier, p.option]));
    expect(sel.picks.map((p) => p.tier)).toEqual(['value', 'recommended', 'premium']);
    expect(byTier.value!.model).toBe('Cheap'); // lowest cost/sqm
    expect(byTier.premium!.model).toBe('Fine'); // finest pitch
    // recommended is the top-ranked (best-fit) config
    expect(byTier.recommended!.productId).toBe(ranked[0]!.productId);
    expect(sel.distinctProducts).toBe(3);
  });

  it('returns fewer-than-3 distinct products gracefully when only one product fits', () => {
    const one = [TIER_PRODUCTS[1]!];
    const ranked = configureScreen(one, { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS }).options;
    const sel = selectTiers(ranked, lookupOf(one));
    expect(sel.picks.length).toBe(3); // still three tiers
    expect(sel.distinctProducts).toBe(1); // but all the same product
  });

  it('returns no picks for an empty ranked list', () => {
    expect(selectTiers([], lookupOf(TIER_PRODUCTS))).toEqual({ picks: [], distinctProducts: 0 });
  });
});
