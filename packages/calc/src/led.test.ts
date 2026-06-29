import { describe, expect, it } from 'vitest';
import { WORKBOOK_DEFAULTS } from './constants.js';
import { freightWeightKg, ledSpec, ledSupply, seaFreightAud, sparesCost } from './led.js';

describe('ledSupply', () => {
  it('prices supply as area × cost/sqm(USD)→AUD × LED markup', () => {
    // 2.1504 sqm × (1071/0.6845) AUD/sqm = 3364.614 cost; × 1.5 (unrounded) = 5046.92 sell
    const { costAud, sellAud } = ledSupply(
      { areaSqm: 2.1504, costPerSqmUsd: 1071 },
      WORKBOOK_DEFAULTS,
    );
    expect(costAud.toString()).toBe('3364.61');
    expect(sellAud.toString()).toBe('5046.92');
  });
});

describe('ledSpec', () => {
  it('derives snapped size, resolution, area and weight (sample screen, rotated)', () => {
    const spec = ledSpec({
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      cabinetWidthMm: 320,
      cabinetHeightMm: 160,
      rotate: true,
      pixelPitchHmm: 1.86,
      pixelPitchVmm: 1.86,
      kgPerSqm: 23,
    });
    expect(spec.widthMm).toBe(1120);
    expect(spec.heightMm).toBe(1920);
    expect(spec.resolutionWpx).toBe(602);
    expect(spec.resolutionHpx).toBe(1032);
    expect(spec.totalPixels).toBe(621264);
    expect(spec.areaSqm.toString()).toBe('2.1504');
    // 2.1504 × 23 = 49.4592 ≈ 49.46 kg (sheet quotes ~50kg)
    expect(spec.weightKg.toString()).toBe('49.46');
  });
});

describe('sparesCost', () => {
  it('defaults to 10% of supply, marked up by LED markup', () => {
    // 5000 × 0.10 = 500 cost; × 1.5 = 750 sell
    const r = sparesCost(5000, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('500');
    expect(r.sellAud.toString()).toBe('750');
  });
  it('honours a configurable percentage', () => {
    expect(sparesCost(5000, WORKBOOK_DEFAULTS, 0.05).costAud.toString()).toBe('250');
  });
});

describe('freightWeightKg', () => {
  it('takes the greater of actual and volumetric (modifier ≥ 1)', () => {
    expect(freightWeightKg(79, 1.6)).toBeCloseTo(126.4, 1); // volumetric wins
    expect(freightWeightKg(100, 1)).toBe(100); // equal → actual
  });
});

describe('seaFreightAud', () => {
  it('computes sea freight from origin/transit/destination constants', () => {
    // (660 + 90×10)/0.6845 + 1200 = 2279.03 + 1200 = 3479.03; ×1.3 = 4522.75
    expect(seaFreightAud(10, WORKBOOK_DEFAULTS).toString()).toBe('4522.75');
  });
});
