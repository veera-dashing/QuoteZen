import { describe, expect, it } from 'vitest';
import { WORKBOOK_DEFAULTS } from './constants.js';
import { estimateInstallHours, ledInstall } from './install.js';

describe('ledInstall', () => {
  it('labour × assembly rate, marked up by the service markup (1.65)', () => {
    // 10h × $45 = 450 labour; × 1.65 = 742.50
    const r = ledInstall({ labourHours: 10 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('450');
    expect(r.sellAud.toString()).toBe('742.5');
  });

  it('adds location uplift to the hourly rate', () => {
    // 10h × (45 + 37) = 820 cost; × 1.65 = 1353
    const r = ledInstall({ labourHours: 10, locationHourlyUplift: 37 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('820');
    expect(r.sellAud.toString()).toBe('1353');
  });

  it('marks up access + freight but passes engineering through at list price', () => {
    // labour 450 + access 600 + freight 200 = 1250; ×1.65 = 2062.5; + engineering 1590 = 3652.5
    const r = ledInstall(
      { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, engineeringPrice: 1590 },
      WORKBOOK_DEFAULTS,
    );
    expect(r.costAud.toString()).toBe('2840'); // 1250 + 1590
    expect(r.sellAud.toString()).toBe('3652.5');
  });

  it('rejects negative hours', () => {
    expect(() => ledInstall({ labourHours: -1 }, WORKBOOK_DEFAULTS)).toThrow();
  });

  // AA6b — flat per-screen freight override.
  it('freight override undefined → identical to the weight-based freight (strict no-op)', () => {
    const base = { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, engineeringPrice: 1590 };
    const without = ledInstall(base, WORKBOOK_DEFAULTS);
    const explicitUndef = ledInstall({ ...base, freightOverridePerScreenAud: undefined }, WORKBOOK_DEFAULTS);
    expect(explicitUndef.costAud.toString()).toBe(without.costAud.toString());
    expect(explicitUndef.sellAud.toString()).toBe(without.sellAud.toString());
    expect(without.costAud.toString()).toBe('2840');
    expect(without.sellAud.toString()).toBe('3652.5');
  });

  it('freight override set → freight = the flat rate (replaces weight-based freight)', () => {
    // labour 450 + access 600 + override 90 = 1140; ×1.65 = 1881; + engineering 1590 = 3471
    const r = ledInstall(
      { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, freightOverridePerScreenAud: 90, engineeringPrice: 1590 },
      WORKBOOK_DEFAULTS,
    );
    expect(r.costAud.toString()).toBe('2730'); // 1140 + 1590
    expect(r.sellAud.toString()).toBe('3471');
    // Cross-check: replacing 200 with 90 drops cost by 110 and sell by 110×1.65 = 181.5.
    const baseline = ledInstall(
      { labourHours: 10, accessEquipmentDayRate: 600, freightCostAud: 200, engineeringPrice: 1590 },
      WORKBOOK_DEFAULTS,
    );
    expect(baseline.costAud.minus(r.costAud).toString()).toBe('110');
    expect(baseline.sellAud.minus(r.sellAud).toString()).toBe('181.5');
  });

  it('freight override applies even with no weight-based freight (free-to-location case)', () => {
    // No freightCostAud at all, but a per-screen charge applies. labour 450 + override 90 = 540; ×1.65 = 891
    const r = ledInstall({ labourHours: 10, freightOverridePerScreenAud: 90 }, WORKBOOK_DEFAULTS);
    expect(r.costAud.toString()).toBe('540');
    expect(r.sellAud.toString()).toBe('891');
  });
});

describe('estimateInstallHours', () => {
  it('base + size + frame + hanging', () => {
    // base 2 + ceil(2.15)=3 + frame 4 + hanging 4 = 13
    expect(estimateInstallHours({ areaSqm: 2.15, frameInstallHours: 4, hanging: true })).toBe(13);
    // base 2 + ceil(2.15)=3 = 5
    expect(estimateInstallHours({ areaSqm: 2.15 })).toBe(5);
  });
});
