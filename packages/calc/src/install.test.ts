import { describe, expect, it } from 'vitest';
import { WORKBOOK_DEFAULTS } from './constants.js';
import { estimateInstallHours, ledInstall } from './install.js';

describe('ledInstall', () => {
  it('labour × install rate ($95), marked up by the service markup (1.65)', () => {
    // 10h × $95 = 950 labour; + 0 overhead; × 1.65 = 1567.50
    const r = ledInstall({ labourHours: 10, overheadCostAud: 0 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('950');
    expect(r.sellAud.toString()).toBe('1567.5');
  });

  it('adds location uplift to the hourly rate', () => {
    // 10h × (95 + 37) = 1320 cost; × 1.65 = 2178
    const r = ledInstall({ labourHours: 10, locationHourlyUplift: 37, overheadCostAud: 0 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('1320');
    expect(r.sellAud.toString()).toBe('2178');
  });

  it('includes standard overhead allowance', () => {
    // 10h × $95 = 950 labour; + 475 overhead = 1425; × 1.65 = 2351.25
    const r = ledInstall({ labourHours: 10, overheadCostAud: 475 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('1425');
    expect(r.sellAud.toString()).toBe('2351.25');
  });

  it('marks up access + freight + overhead but passes engineering through at list price', () => {
    // labour 950 + access 600 + freight 200 + overhead 475 = 2225; ×1.65 = 3671.25; + engineering 1590 = 5261.25
    const r = ledInstall(
      { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, overheadCostAud: 475, engineeringPrice: 1590 },
      WORKBOOK_DEFAULTS,
    );
    expect(r.costAud.toString()).toBe('3815'); // 2225 + 1590
    expect(r.sellAud.toString()).toBe('5261.25');
  });

  it('rejects negative hours', () => {
    expect(() => ledInstall({ labourHours: -1 }, WORKBOOK_DEFAULTS)).toThrow();
  });

  // AA6b — flat per-screen freight override.
  it('freight override undefined → identical to the weight-based freight (strict no-op)', () => {
    const base = { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, overheadCostAud: 0, engineeringPrice: 1590 };
    const without = ledInstall(base, WORKBOOK_DEFAULTS);
    const explicitUndef = ledInstall({ ...base, freightOverridePerScreenAud: undefined }, WORKBOOK_DEFAULTS);
    expect(explicitUndef.costAud.toString()).toBe(without.costAud.toString());
    expect(explicitUndef.sellAud.toString()).toBe(without.sellAud.toString());
  });

  it('freight override set → freight = the flat rate (replaces weight-based freight)', () => {
    // labour 950 + access 600 + override 90 = 1640; ×1.65 = 2706; + engineering 1590 = 4296
    const r = ledInstall(
      { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, overheadCostAud: 0, freightOverridePerScreenAud: 90, engineeringPrice: 1590 },
      WORKBOOK_DEFAULTS,
    );
    expect(r.costAud.toString()).toBe('3230'); // 1640 + 1590
    expect(r.sellAud.toString()).toBe('4296');
  });

  it('freight override applies even with no weight-based freight (free-to-location case)', () => {
    // No freightCostAud at all, but a per-screen charge applies. labour 950 + override 90 = 1040; ×1.65 = 1716
    const r = ledInstall({ labourHours: 10, overheadCostAud: 0, freightOverridePerScreenAud: 90 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('1040');
    expect(r.sellAud.toString()).toBe('1716');
  });
});

describe('estimateInstallHours', () => {
  it('cabinet-based formula matches Excel (e.g. 2x4 cabinets = 8 size hrs + 4 base = 12 hrs)', () => {
    // 2.4576 sqm, 2 cabinets W, 4 cabinets H, 640x480 cabinets -> 4 base + 8 size = 12
    expect(
      estimateInstallHours({
        areaSqm: 2.4576,
        cabinetsW: 2,
        cabinetsH: 4,
        cabinetWMm: 640,
        cabinetHMm: 480,
      }),
    ).toBe(12);
  });

  it('adds frame and hanging uplifts', () => {
    // 4 base + 8 size + 4 frame + 4 hanging = 20
    expect(
      estimateInstallHours({
        areaSqm: 2.4576,
        cabinetsW: 2,
        cabinetsH: 4,
        cabinetWMm: 640,
        cabinetHMm: 480,
        frameInstallHours: 4,
        hanging: true,
      }),
    ).toBe(20);
  });

  it('fallback when cabinet counts not provided', () => {
    // base 4 + Math.round(max(4, 2.15)/2)*2 = 4 + 4 = 8
    expect(estimateInstallHours({ areaSqm: 2.15 })).toBe(8);
  });
});
