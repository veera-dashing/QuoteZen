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
});

describe('estimateInstallHours', () => {
  it('base + size + frame + hanging', () => {
    // base 2 + ceil(2.15)=3 + frame 4 + hanging 4 = 13
    expect(estimateInstallHours({ areaSqm: 2.15, frameInstallHours: 4, hanging: true })).toBe(13);
    // base 2 + ceil(2.15)=3 = 5
    expect(estimateInstallHours({ areaSqm: 2.15 })).toBe(5);
  });
});
