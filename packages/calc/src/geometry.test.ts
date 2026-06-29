import { describe, expect, it } from 'vitest';
import {
  areaSqm,
  resolutionPx,
  resolveScreenRatio,
  snapToCabinets,
  type ScreenRatioRow,
} from './geometry.js';

describe('geometry', () => {
  it('snaps a size to whole cabinets (320×160 modules, not rotated)', () => {
    const s = snapToCabinets({
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      cabinetWidthMm: 320,
      cabinetHeightMm: 160,
    });
    // 1120/320 = 3.5 → round 4 → 1280; 1920/160 = 12 → 1920
    expect(s.widthMm).toBe(1280);
    expect(s.heightMm).toBe(1920);
    expect(s.cabinetsWide).toBe(4);
    expect(s.cabinetsHigh).toBe(12);
    expect(s.cabinetCount).toBe(48);
  });

  it('rotating swaps the cabinet units (sample LED screen: exact fit)', () => {
    const s = snapToCabinets({
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      cabinetWidthMm: 320,
      cabinetHeightMm: 160,
      rotate: true,
    });
    // rotated: widthUnit=160 → 1120/160=7 → 1120; heightUnit=320 → 1920/320=6 → 1920
    expect(s.widthMm).toBe(1120);
    expect(s.heightMm).toBe(1920);
    expect(s.cabinetCount).toBe(42);
  });

  it('never snaps below one cabinet', () => {
    const s = snapToCabinets({
      desiredWidthMm: 100,
      desiredHeightMm: 100,
      cabinetWidthMm: 320,
      cabinetHeightMm: 160,
    });
    expect(s.cabinetCount).toBe(1);
  });

  it('computes active area in sqm', () => {
    expect(areaSqm(1120, 1920).toString()).toBe('2.1504');
  });

  it('derives pixel resolution from pitch (1.86mm → 602×1032 for 1120×1920)', () => {
    expect(resolutionPx(1120, 1.86)).toBe(602);
    expect(resolutionPx(1920, 1.86)).toBe(1032);
  });

  it('rejects non-positive pitch and height', () => {
    expect(() => resolutionPx(1000, 0)).toThrow();
    expect(() => resolveScreenRatio(1000, 0, [])).toThrow();
  });

  it('resolves the human screen ratio via the lookup table', () => {
    const ratios: ScreenRatioRow[] = [
      { minValue: 1.69, maxValue: 1.88, ratioLabel: '16:9' },
      { minValue: 0.54, maxValue: 0.59, ratioLabel: '9:16' },
    ];
    expect(resolveScreenRatio(1920, 1080, ratios)).toBe('16:9');
    expect(resolveScreenRatio(1080, 1920, ratios)).toBe('9:16');
    expect(resolveScreenRatio(5000, 1000, ratios)).toBeNull();
  });
});
