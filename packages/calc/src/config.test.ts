import { describe, expect, it } from 'vitest';
import { configConfidence, configureScreen, PREFERRED_RATIO_LABELS, selectTiers, type ConfigProduct } from './config.js';
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

describe('configConfidence (U8)', () => {
  it('scores an exact fit on a preferred ratio at 100', () => {
    // 1000×1000 on the 500² cabinet → exact 100% fill, 1:1 (preferred), 0 size delta → 100.
    const res = configureScreen([PRODUCTS[1]!], { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS });
    const opt = res.options[0]!;
    expect(opt.fillPercent.toString()).toBe('100');
    expect(opt.ratioPreferred).toBe(true);
    expect(configConfidence(opt)).toBe(100);
  });

  it('penalises a non-preferred ratio and an over/under size delta (lower score)', () => {
    // 900×1100 on a 320×160 cabinet → non-exact fill + non-preferred ratio + a size delta → well below 100.
    const res = configureScreen([PRODUCTS[0]!], { desiredWidthMm: 900, desiredHeightMm: 1100, ratios: RATIOS });
    const opt = res.options.find((o) => !o.ratioPreferred || !o.sizeDeltaPct.isZero()) ?? res.options[0]!;
    const score = configConfidence(opt);
    expect(score).toBeLessThan(100);
    // A build that is non-preferred (−20) alone already caps it under 100; combined penalties push lower.
    if (!opt.ratioPreferred) expect(score).toBeLessThanOrEqual(80);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('clamps to [0,100] for an extreme mismatch', () => {
    // Force every penalty to max: |fill−100| ≥ 40, non-preferred (−20), |sizeDelta|×2 ≥ 25.
    // A tiny opening vs a large cabinet → huge over-fill.
    const res = configureScreen([PRODUCTS[1]!], { desiredWidthMm: 100, desiredHeightMm: 100, ratios: RATIOS });
    const opt = res.options[0]!;
    const score = configConfidence(opt);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    // 500×500 built for a 100×100 opening → fill = 2500% (|−100|=2400 → cap 40); sizeDelta huge (cap 25);
    // 1:1 is preferred so no ratio penalty → 100 − 40 − 0 − 25 = 35.
    expect(score).toBe(35);
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

describe('configureScreen — per-model priority ordering', () => {
  // Same manufacturer (priority 1) so the manufacturer key ties; the models differ only by modelPriority.
  // The admin-set model priority must decide, overriding the best-fit + model-name tiebreaks below it.
  const mk = (id: string, model: string, modelPriority: number, w = 500, h = 500): ConfigProduct => ({
    id,
    model,
    minCabinetWMm: w,
    minCabinetHMm: h,
    pixelPitchHmm: 2.6,
    pixelPitchVmm: 2.6,
    manufacturerPriority: 1,
    manufacturerName: 'LEDFul',
    modelPriority,
  });

  it('orders by model priority within a manufacturer (lower wins), beating the model-name tiebreak', () => {
    // Both are an exact 1000×1000 fit → identical area deviation. 'ZModel' has the lower model priority,
    // so it must rank ahead of 'AModel' despite sorting later alphabetically.
    const A = mk('a', 'AModel', 50);
    const Z = mk('z', 'ZModel', 10);
    const res = configureScreen([A, Z], { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS }).options;
    expect(res[0]!.model).toBe('ZModel');
    expect(res[0]!.modelPriority).toBe(10);
    expect(res[1]!.model).toBe('AModel');
  });

  it('manufacturer priority still WINS over model priority (mfr is primary)', () => {
    // Preferred manufacturer (priority 1) with a HIGH model priority vs a worse manufacturer (priority 3)
    // with a LOW model priority → the manufacturer key decides first.
    const PREF = mk('p', 'HighModel', 900);
    const OTHER: ConfigProduct = { ...mk('o', 'LowModel', 1), manufacturerPriority: 3, manufacturerName: 'Muxwave' };
    const res = configureScreen([OTHER, PREF], { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS }).options;
    expect(res[0]!.manufacturerName).toBe('LEDFul');
    expect(res[0]!.model).toBe('HighModel');
  });

  it('defaults to a neutral priority (100) when unset, so ranking is unchanged by fit', () => {
    const res = configureScreen([mk('x', 'PlainNoPri', undefined as unknown as number)], {
      desiredWidthMm: 1000,
      desiredHeightMm: 1000,
      ratios: RATIOS,
    }).options;
    expect(res[0]!.modelPriority).toBe(100);
  });
});

describe('configureScreen — W0 environment filter (+ brightness fallback)', () => {
  // Four 500mm-square products that all fit 1000×1000 exactly; they differ only in environment/brightness:
  //  E1 explicit indoor;  E2 explicit outdoor;  B_HI no env + 5000 nits (→ outdoor via fallback);
  //  B_LO no env + 800 nits (→ indoor via fallback).
  const E1: ConfigProduct = { id: 'e-indoor', model: 'ExpIndoor', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6, environment: 'indoor', brightnessNits: 800 };
  const E2: ConfigProduct = { id: 'e-outdoor', model: 'ExpOutdoor', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6, environment: 'outdoor', brightnessNits: 6000 };
  const B_HI: ConfigProduct = { id: 'b-hi', model: 'BrightNoEnv', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6, environment: null, brightnessNits: 5000 };
  const B_LO: ConfigProduct = { id: 'b-lo', model: 'DimNoEnv', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.6, pixelPitchVmm: 2.6, environment: null, brightnessNits: 800 };
  const ALL = [E1, E2, B_HI, B_LO];
  const opening = { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS };

  it('no environment requested → no filter (all products offered)', () => {
    const res = configureScreen(ALL, opening);
    const ids = new Set(res.options.map((o) => String(o.productId)));
    expect(ids).toEqual(new Set(['e-indoor', 'e-outdoor', 'b-hi', 'b-lo']));
  });

  it('environment=outdoor keeps explicit-outdoor + bright-no-env (fallback), drops indoor + dim', () => {
    const res = configureScreen(ALL, { ...opening, environment: 'outdoor', outdoorBrightnessNits: 4000 });
    const ids = res.options.map((o) => String(o.productId));
    expect(new Set(ids)).toEqual(new Set(['e-outdoor', 'b-hi']));
    expect(ids).not.toContain('e-indoor');
    expect(ids).not.toContain('b-lo'); // 800 nits < 4000 → indoor by fallback
  });

  it('environment=indoor keeps explicit-indoor + dim-no-env (fallback), drops outdoor + bright', () => {
    const res = configureScreen(ALL, { ...opening, environment: 'indoor', outdoorBrightnessNits: 4000 });
    expect(new Set(res.options.map((o) => String(o.productId)))).toEqual(new Set(['e-indoor', 'b-lo']));
  });

  it('threshold moves the fallback boundary (5000-nit no-env product becomes indoor at threshold 6000)', () => {
    const res = configureScreen([B_HI], { ...opening, environment: 'indoor', outdoorBrightnessNits: 6000 });
    // 5000 < 6000 → indoor now, so it survives the indoor filter.
    expect(res.options.map((o) => String(o.productId))).toEqual(['b-hi']);
  });

  it('empty-with-reasons when no product matches the requested environment', () => {
    const res = configureScreen([E1, B_LO], { ...opening, environment: 'outdoor', outdoorBrightnessNits: 4000 });
    expect(res.options).toEqual([]);
    expect(res.reasons[0]).toMatch(/No outdoor products/);
  });
});

describe('configureScreen — W0 viewing-distance filter + coarsest-fit ranking', () => {
  // Three fine/coarse products (all 500mm square, exact fit at 1000×1000, same manufacturer default):
  const FINE: ConfigProduct = { id: 'p1_5', model: 'Fine15', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 1.5, pixelPitchVmm: 1.5 };
  const MID: ConfigProduct = { id: 'p2_0', model: 'Mid20', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.0, pixelPitchVmm: 2.0 };
  const COARSE: ConfigProduct = { id: 'p3_0', model: 'Coarse30', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 3.0, pixelPitchVmm: 3.0 };
  const ALL = [FINE, MID, COARSE];
  const opening = { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS };

  it('excludes products coarser than the max pitch (≈1mm : 1m); 2m → pitch > 2mm dropped', () => {
    const res = configureScreen(ALL, { ...opening, viewingDistanceM: 2 });
    const ids = res.options.map((o) => String(o.productId));
    expect(ids).toContain('p1_5'); // 1.5 ≤ 2
    expect(ids).toContain('p2_0'); // 2.0 ≤ 2 (inclusive)
    expect(ids).not.toContain('p3_0'); // 3.0 > 2 → excluded
  });

  it('ranks the coarsest pitch that still fits FIRST (best value) at equal fit + manufacturer', () => {
    // All three are equal on every prior key (exact 1000×1000, non-rotated, same mfr) — so at 3m the
    // coarsest surviving pitch (3.0) should rank ahead of 2.0 and 1.5.
    const res = configureScreen(ALL, { ...opening, viewingDistanceM: 3 });
    expect(res.options.map((o) => o.pixelPitchMm)).toEqual([3.0, 2.0, 1.5]);
  });

  it('no viewing distance → no pitch filter and no coarsest bias (model-name tiebreak preserved)', () => {
    const res = configureScreen(ALL, opening);
    expect(res.options).toHaveLength(3);
    // Without the coarsest bias the final tiebreak is model name: Coarse30 < Fine15 < Mid20.
    expect(res.options.map((o) => o.model)).toEqual(['Coarse30', 'Fine15', 'Mid20']);
  });

  it('empty-with-reasons when every product is too coarse for the distance', () => {
    const res = configureScreen([COARSE], { ...opening, viewingDistanceM: 1 });
    expect(res.options).toEqual([]);
    expect(res.reasons[0]).toMatch(/No products fine enough/);
  });
});

describe('configureScreen — W0 gobRecommended + pixelPitchMm', () => {
  const opening = { desiredWidthMm: 1000, desiredHeightMm: 1000, ratios: RATIOS };
  it('gobRecommended true for fine pitch (<2.5mm) and exposes pixelPitchMm', () => {
    const FINE: ConfigProduct = { id: 'g1', model: 'Fine', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 1.8, pixelPitchVmm: 1.8 };
    const o = configureScreen([FINE], opening).options[0]!;
    expect(o.pixelPitchMm).toBe(1.8);
    expect(o.gobRecommended).toBe(true);
  });

  it('gobRecommended false at/above 2.5mm', () => {
    const AT: ConfigProduct = { id: 'g2', model: 'At', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 2.5, pixelPitchVmm: 2.5 };
    const COARSE: ConfigProduct = { id: 'g3', model: 'Coarse', minCabinetWMm: 500, minCabinetHMm: 500, pixelPitchHmm: 4, pixelPitchVmm: 4 };
    expect(configureScreen([AT], opening).options[0]!.gobRecommended).toBe(false); // exactly 2.5 → not recommended
    expect(configureScreen([COARSE], opening).options[0]!.gobRecommended).toBe(false);
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
