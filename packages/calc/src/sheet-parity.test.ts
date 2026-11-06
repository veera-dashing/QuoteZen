import { describe, expect, it } from 'vitest';
import { controllerPortsNeeded, selectController, type ControllerSpec } from './controller.js';
import { freightWeightKg, shippingBoxKg, trimCostAud } from './led.js';
import { WORKBOOK_DEFAULTS } from './constants.js';
import {
  estimateInstallHours,
  installHoursBreakdown,
  MEDIAPLAYER_CONFIG_COST_AUD,
  STANDARD_OVERHEAD_ITEMS,
} from './install.js';

describe('install itemisation — (LED 1) rows 304–327', () => {
  it('the itemised standard overhead totals the default (595) and includes PM 2 h', () => {
    const total = STANDARD_OVERHEAD_ITEMS.reduce((s, i) => s + i.costAud, 0);
    expect(total).toBe(WORKBOOK_DEFAULTS.freight.standardOverheadAud);
    expect(STANDARD_OVERHEAD_ITEMS.find((i) => /project management/i.test(i.label))?.costAud).toBe(240);
    expect(MEDIAPLAYER_CONFIG_COST_AUD).toBe(45);
  });

  it('Superdry 1500 × 2000 on 1000 × 500 cabinets: 4 base + 8 size + 4 frame = 16 h', () => {
    const opts = { areaSqm: 3, cabinetsW: 2, cabinetsH: 4, cabinetWMm: 1000, cabinetHMm: 500, baseHours: 4, frameInstallHours: 4 };
    expect(installHoursBreakdown(opts)).toEqual({ base: 4, size: 8, frame: 4, hanging: 0, total: 16 });
    expect(estimateInstallHours(opts)).toBe(16); // the total is unchanged by the breakdown
  });
});

/**
 * Parity with the Quote Base V1.6 workbook, using the Superdry (Werribee) job:
 * IAF250 / WALL-PRO2.5 — 1000 × 500 cabinets, ship depth 8 cm, 21 kg/m², volumetric modifier 1.3.
 */
const WALL_PRO_25 = { cabinetWMm: 1000, cabinetHMm: 500, shipDepthCm: 8, kgPerSqm: 21, vol: 1.3 };

describe('shippingBoxKg — (LED 1) rows 249–250 packed-box freight weight', () => {
  it('1500 × 2000: box 110 × 74 × 70 cm → 114 kg (beats actual 63 kg × 1.3 = 81.9)', () => {
    const kg = shippingBoxKg({
      cabinetWMm: WALL_PRO_25.cabinetWMm,
      cabinetHMm: WALL_PRO_25.cabinetHMm,
      cabinetsWide: 1500 / 1000,
      cabinetsHigh: 2000 / 500,
      screenHeightMm: 2000,
      shipDepthCm: WALL_PRO_25.shipDepthCm,
      actualKg: 3 * WALL_PRO_25.kgPerSqm,
      volumetricModifier: WALL_PRO_25.vol,
    });
    expect(kg).toBe(114);
  });

  it('1500 × 2500 (the sheet as received): box 110 × 90 × 70 cm → 139 kg', () => {
    const kg = shippingBoxKg({
      cabinetWMm: 1000,
      cabinetHMm: 500,
      cabinetsWide: 1.5,
      cabinetsHigh: 5,
      screenHeightMm: 2500,
      shipDepthCm: 8,
      actualKg: 3.75 * 21,
      volumetricModifier: 1.3,
    });
    expect(kg).toBe(139);
  });

  it('box depth never drops below 28 cm, and a dense screen keeps its actual weight', () => {
    // 1 cabinet × 8 cm + 10 = 18 → floor 28; box 110 × 28 × 70 / 5000 = 43.12 → 44 kg.
    expect(
      shippingBoxKg({ cabinetWMm: 1000, cabinetHMm: 500, cabinetsWide: 1, cabinetsHigh: 1, screenHeightMm: 500, shipDepthCm: 8, actualKg: 10 }),
    ).toBe(44);
    // Heavy steel: actual × modifier (200 × 1.2 = 240) is greater than the box → 240.
    expect(
      shippingBoxKg({ cabinetWMm: 960, cabinetHMm: 960, cabinetsWide: 1, cabinetsHigh: 1, screenHeightMm: 960, shipDepthCm: 12, actualKg: 200, volumetricModifier: 1.2 }),
    ).toBe(240);
  });

  it('the old fallback (no ship depth) is unchanged', () => {
    expect(freightWeightKg(63, 1.3)).toBeCloseTo(81.9, 6);
  });
});

describe('trimCostAud — (LED 1) row 292', () => {
  it('Sides Only ($0 / $60 per m): 1500 × 2000 → $120, 1500 × 2500 → $150', () => {
    expect(trimCostAud(0, 60, 1.5, 2.0)).toBe(120);
    expect(trimCostAud(0, 60, 1.5, 2.5)).toBe(150);
  });
  it('All Edges ($60 / $60) and Sides & Bottom ($30 / $60)', () => {
    expect(trimCostAud(60, 60, 1.5, 2.0)).toBe(210);
    expect(trimCostAud(30, 60, 1.5, 2.0)).toBe(165);
  });
});

describe('controller selection — (LED 1) H248 ports + B270 "Standard" type', () => {
  // The catalogue as of V1.6 (ports / pixels / type / price).
  const CATALOGUE: ControllerSpec[] = [
    { id: 1, name: 'Sending Box - MCTRL300', type: 'Standard', maxPorts: 2, maxPixels: 1_300_000, cost: 274.98 },
    { id: 2, name: 'Sending Box - MCTRL700', type: 'Standard', maxPorts: 6, maxPixels: 2_600_000, cost: 506.06 },
    { id: 3, name: 'Video Processor and Sender - VX400Pro', type: 'With Scalar or Switch (VX)', maxPorts: 4, maxPixels: 2_600_000, cost: 1892.51 },
    { id: 4, name: 'Sending Card - MSD300', type: 'Card Only (MSD300)', maxPorts: 1, maxPixels: 650_000, cost: 182.55 },
  ];

  it('ports: WALL products need one per metre of width; others go by pixels', () => {
    expect(controllerPortsNeeded({ model: 'IAF250 / WALL-PRO2.5', widthMm: 1500, pixels: 480_000 })).toBe(2);
    expect(controllerPortsNeeded({ model: 'IAF250 / WALL-PRO2.5', widthMm: 1500, pixels: 600_000 })).toBe(2);
    expect(controllerPortsNeeded({ model: 'IAF320 / BM2.5', widthMm: 1500, pixels: 480_000 })).toBe(1);
    expect(controllerPortsNeeded({ model: 'IAF320 / BM2.5', widthMm: 3000, pixels: 1_400_000 })).toBe(3);
  });

  it('Superdry 1500 × 2000 WALL-PRO2.5 (480k px, 2 ports) → MCTRL300, not the 1-port MSD300', () => {
    const ports = controllerPortsNeeded({ model: 'IAF250 / WALL-PRO2.5', widthMm: 1500, pixels: 480_000 });
    const res = selectController(480_000, CATALOGUE, { portsNeeded: ports, preferType: 'Standard' });
    expect(res.controller?.name).toBe('Sending Box - MCTRL300');
  });

  it('a 1-port screen still gets the workbook default (Standard) rather than the cheaper card', () => {
    const res = selectController(300_000, CATALOGUE, { portsNeeded: 1, preferType: 'Standard' });
    expect(res.controller?.name).toBe('Sending Box - MCTRL300');
  });

  it('more than 2 ports → MCTRL700 (B270: IF(ports > MCTRL300 ports, MCTRL700, MCTRL300))', () => {
    const res = selectController(1_000_000, CATALOGUE, { portsNeeded: 3, preferType: 'Standard' });
    expect(res.controller?.name).toBe('Sending Box - MCTRL700');
  });

  it('too many ports for any single unit → multiple of the most-ported controller', () => {
    const res = selectController(1_000_000, CATALOGUE, { portsNeeded: 10, preferType: 'Standard' });
    expect(res.controller).toBeNull();
    expect(res.needsMultiController).toBe(true);
    expect(res.multiControllerCount).toBe(2); // ⌈10 / 6⌉ × MCTRL700
    expect(res.reason).toContain('MCTRL700');
  });

  it('no options → the original pixel-only behaviour (cheapest sufficient capacity)', () => {
    expect(selectController(480_000, CATALOGUE).controller?.name).toBe('Sending Card - MSD300');
  });
});
