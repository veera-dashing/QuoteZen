import { describe, expect, it } from 'vitest';
import { configureScreen, PREFERRED_RATIO_LABELS, selectTiers, type ConfigProduct } from './config.js';
import type { ScreenRatioRow } from './geometry.js';

const RATIOS: ScreenRatioRow[] = [
  { minValue: 1.69, maxValue: 1.88, ratioLabel: '16:9' },
  { minValue: 0.54, maxValue: 0.59, ratioLabel: '9:16' },
  { minValue: 0.91, maxValue: 1.12, ratioLabel: '1:1' },
  // a band that is NOT in the preferred set (≈7:12 ≈ 0.583… falls in 9:16; use 4:5 for non-preferred)
  { minValue: 0.78, maxValue: 0.9, ratioLabel: '4:5' },
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

describe('configureScreen — T3 over/under sizing', () => {
  // 500mm square cabinet, opening 1100×1100: exact 2.2 cab → fit=1000 (2 cab), under=1000 (floor 2),
  // over=1500 (ceil 3). So for each axis we get under(1000)/over(1500); fit==under here.
  const SQ500: ConfigProduct = { id: 20, model: 'Sq500', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6 };

  it('classifies exact / under / over and computes signed deltas + sizeDeltaPct', () => {
    // Exact fit: 1000×1000 on a 500 cabinet divides evenly → sizeMode exact, zero deltas, 0%.
    const exact = configureScreen([SQ500], { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS }).options;
    expect(exact).toHaveLength(1); // under/over/fit all collapse to 1000×1000
    expect(exact[0]!.sizeMode).toBe('exact');
    expect(exact[0]!.deltaWidthMm).toBe(0);
    expect(exact[0]!.deltaHeightMm).toBe(0);
    expect(exact[0]!.sizeDeltaPct.toString()).toBe('0');

    // 1100×1100: fit→1000 (round 2.2→2), under→1000 (floor), over→1500 (ceil). Distinct geometries: 2.
    const res = configureScreen([SQ500], { desiredWidthMm: 1100, desiredHeightMm: 1100, ratios: RATIOS }).options;
    const sizes = new Set(res.map((o) => `${o.widthMm}x${o.heightMm}`));
    expect(sizes.has('1000x1000')).toBe(true); // under (smaller than opening)
    expect(sizes.has('1500x1500')).toBe(true); // over (larger than opening)

    const under = res.find((o) => o.widthMm === 1000)!;
    expect(under.sizeMode).toBe('under');
    expect(under.deltaWidthMm).toBe(-100); // 1000 − 1100
    expect(under.sizeDeltaPct.isNegative()).toBe(true);

    const over = res.find((o) => o.widthMm === 1500)!;
    expect(over.sizeMode).toBe('over');
    expect(over.deltaWidthMm).toBe(400); // 1500 − 1100
    expect(over.sizeDeltaPct.isNegative()).toBe(false);
    expect(Number(over.sizeDeltaPct)).toBeGreaterThan(0);
  });

  it('dedupes identical geometry across fit/under/over (no duplicate options for an even opening)', () => {
    // 2000×1500 divides evenly (4×3 cabinets) → fit==under==over per axis → exactly one option.
    const res = configureScreen([SQ500], { desiredWidthMm: 2000, desiredHeightMm: 1500, ratios: RATIOS }).options;
    expect(res).toHaveLength(1);
    expect(res[0]!.sizeMode).toBe('exact');
  });

  it('best-fit (closest area) still ranks first; under/over are additional candidates', () => {
    // 1100×1100 → the nearest fit (1000×1000, −17% area) is closer than the over (1500×1500, +106%),
    // so the under/closest option must rank ahead of the over variant.
    const res = configureScreen([SQ500], { desiredWidthMm: 1100, desiredHeightMm: 1100, ratios: RATIOS }).options;
    expect(res[0]!.widthMm).toBe(1000);
    expect(res[res.length - 1]!.widthMm).toBe(1500);
  });
});

describe('configureScreen — T3 aspect-ratio guardrail', () => {
  const SQ500: ConfigProduct = { id: 30, model: 'Sq500', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6 };

  it('marks a preferred ratio (1:1) as preferred with null guidance', () => {
    const o = configureScreen([SQ500], { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS }).options[0]!;
    expect(o.ratioLabel).toBe('1:1');
    expect(o.ratioPreferred).toBe(true);
    expect(o.ratioGuidance).toBeNull();
    expect(PREFERRED_RATIO_LABELS).toContain('1:1');
  });

  it('flags a non-preferred ratio (4:5) with guidance naming the closest preferred', () => {
    // 2000×2500 on a 500 cabinet → 4×5 cabinets, exact 2000×2500 → ratio 0.8 → 4:5 (NOT preferred).
    const o = configureScreen([SQ500], { desiredWidthMm: 2000, desiredHeightMm: 2500, ratios: RATIOS }).options
      .find((x) => x.ratioLabel === '4:5')!;
    expect(o).toBeDefined();
    expect(o.ratioPreferred).toBe(false);
    expect(o.ratioGuidance).toMatch(/not a preferred ratio/);
    expect(o.ratioGuidance).toMatch(/closest preferred is/);
    // closest preferred to 0.8 among {16:9,2:1,3:1,5:4,1:1,9:16} is 1:1 (1.0) vs 9:16 (0.5625) → 1:1
    expect(o.ratioGuidance).toContain('1:1');
  });
});

describe('configureScreen — U2 manufacturer-priority ordering', () => {
  // Two products that both produce an EXACT 1000×1000 fit (identical area deviation), differing only by
  // manufacturer priority. Without the priority key, the model-name tiebreak would put 'AAA' first; the
  // priority key must override that and put the lower-priority manufacturer first.
  const PREFERRED: ConfigProduct = {
    id: 'pref',
    model: 'ZModel', // model sorts AFTER 'AModel' — proves priority beats the model tiebreak
    minCabinetWMm: 500,
    minCabinetHMm: 500,
    pixelPitchHmm: 2.6,
    pixelPitchVmm: 2.6,
    manufacturerPriority: 1,
    manufacturerName: 'LEDFul',
    leadTimeDays: 45,
  };
  const SECONDARY: ConfigProduct = {
    id: 'sec',
    model: 'AModel',
    minCabinetWMm: 500,
    minCabinetHMm: 500,
    pixelPitchHmm: 2.6,
    pixelPitchVmm: 2.6,
    manufacturerPriority: 3,
    manufacturerName: 'Muxwave',
    leadTimeDays: 60,
  };

  it('orders by manufacturer priority FIRST (lower wins), even at equal best-fit', () => {
    const res = configureScreen([SECONDARY, PREFERRED], {
      desiredWidthMm: 1000,
      desiredHeightMm: 1000,
      ratios: RATIOS,
    }).options;
    expect(res[0]!.manufacturerName).toBe('LEDFul');
    expect(res[0]!.manufacturerPriority).toBe(1);
    expect(res[1]!.manufacturerName).toBe('Muxwave');
    // lead time carried through
    expect(res[0]!.leadTimeDays).toBe(45);
    expect(res[1]!.leadTimeDays).toBe(60);
  });

  it('within a manufacturer, best-fit (closest area) still ranks first', () => {
    // 1100×1100 with the preferred product alone → under(1000) is closer than over(1500); both same mfr.
    const res = configureScreen([PREFERRED], {
      desiredWidthMm: 1100,
      desiredHeightMm: 1100,
      ratios: RATIOS,
    }).options;
    expect(res[0]!.widthMm).toBe(1000); // best fit within the manufacturer
    expect(res[res.length - 1]!.widthMm).toBe(1500);
    expect(res.every((o) => o.manufacturerName === 'LEDFul')).toBe(true);
  });

  it('defaults an unlinked product to a high priority so it sorts after real manufacturers', () => {
    const UNLINKED: ConfigProduct = {
      id: 'none',
      model: 'AAA', // sorts first by model, but no manufacturer → should sort LAST by priority
      minCabinetWMm: 500,
      minCabinetHMm: 500,
      pixelPitchHmm: 2.6,
      pixelPitchVmm: 2.6,
    };
    const res = configureScreen([UNLINKED, PREFERRED], {
      desiredWidthMm: 1000,
      desiredHeightMm: 1000,
      ratios: RATIOS,
    }).options;
    expect(res[0]!.manufacturerName).toBe('LEDFul');
    const unlinked = res.find((o) => o.productId === 'none')!;
    expect(unlinked.manufacturerName).toBeNull();
    expect(unlinked.manufacturerPriority).toBe(999);
    expect(res.indexOf(unlinked)).toBe(res.length - 1);
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
