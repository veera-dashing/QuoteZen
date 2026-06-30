import { describe, expect, it } from 'vitest';
import { selectController, type ControllerSpec } from './controller.js';

// Three controllers spanning a capacity ladder; the mid one is duplicated at a different cost to
// exercise the cost tiebreak.
const CONTROLLERS: ControllerSpec[] = [
  { id: 1, name: 'A-Small', maxPixels: 650_000, cost: 400 },
  { id: 2, name: 'B-Mid', maxPixels: 1_300_000, cost: 700 },
  { id: 3, name: 'C-Large', maxPixels: 2_600_000, cost: 1200 },
];

describe('selectController', () => {
  it('small screen → smallest controller that covers it', () => {
    const res = selectController(300_000, CONTROLLERS);
    expect(res.controller?.name).toBe('A-Small');
    expect(res.needsMultiController).toBe(false);
    expect(res.multiControllerCount).toBe(1);
    expect(res.reason).toBeNull();
  });

  it('mid screen → next controller up (smallest sufficient capacity)', () => {
    const res = selectController(1_000_000, CONTROLLERS);
    expect(res.controller?.name).toBe('B-Mid');
    expect(res.multiControllerCount).toBe(1);
  });

  it('exact-boundary pixels are covered (inclusive capacity)', () => {
    const res = selectController(650_000, CONTROLLERS);
    expect(res.controller?.name).toBe('A-Small');
    expect(res.needsMultiController).toBe(false);
  });

  it('one pixel over a tier escalates to the next controller', () => {
    const res = selectController(650_001, CONTROLLERS);
    expect(res.controller?.name).toBe('B-Mid');
  });

  it('over-capacity → multi-controller count + flag (no error)', () => {
    const res = selectController(6_000_000, CONTROLLERS);
    expect(res.controller).toBeNull();
    expect(res.needsMultiController).toBe(true);
    // ceil(6,000,000 / 2,600,000) = 3
    expect(res.multiControllerCount).toBe(3);
    expect(res.reason).toContain('C-Large');
  });

  it('exact multiple over capacity → exact count', () => {
    const res = selectController(5_200_000, CONTROLLERS);
    expect(res.needsMultiController).toBe(true);
    // ceil(5,200,000 / 2,600,000) = 2
    expect(res.multiControllerCount).toBe(2);
  });

  it('tiebreak: equal capacity → lowest cost, then name', () => {
    const tied: ControllerSpec[] = [
      { id: 10, name: 'Z-Pricey', maxPixels: 1_000_000, cost: 900 },
      { id: 11, name: 'Y-Cheap', maxPixels: 1_000_000, cost: 500 },
      { id: 12, name: 'X-Same', maxPixels: 1_000_000, cost: 500 },
    ];
    const res = selectController(900_000, tied);
    // Both Y and X cost 500; name tiebreak → 'X-Same'.
    expect(res.controller?.name).toBe('X-Same');
  });

  it('missing cost is treated as the most expensive (loses cost tiebreak)', () => {
    const tied: ControllerSpec[] = [
      { id: 20, name: 'NoCost', maxPixels: 1_000_000 },
      { id: 21, name: 'HasCost', maxPixels: 1_000_000, cost: 800 },
    ];
    const res = selectController(900_000, tied);
    expect(res.controller?.name).toBe('HasCost');
  });

  it('empty controller list → empty-with-reason (not a throw)', () => {
    const res = selectController(100_000, []);
    expect(res.controller).toBeNull();
    expect(res.needsMultiController).toBe(false);
    expect(res.multiControllerCount).toBe(0);
    expect(res.reason).toMatch(/no controllers/i);
  });

  it('controllers without a valid capacity are ignored', () => {
    const bad: ControllerSpec[] = [
      { id: 30, name: 'ZeroCap', maxPixels: 0 },
      { id: 31, name: 'NegCap', maxPixels: -5 },
      { id: 32, name: 'Good', maxPixels: 800_000 },
    ];
    const res = selectController(500_000, bad);
    expect(res.controller?.name).toBe('Good');
  });

  it('all controllers invalid → empty-with-reason', () => {
    const res = selectController(500_000, [{ id: 40, name: 'Bad', maxPixels: 0 }]);
    expect(res.controller).toBeNull();
    expect(res.reason).toMatch(/no controllers/i);
  });

  it('zero pixels → reason, no selection', () => {
    const res = selectController(0, CONTROLLERS);
    expect(res.controller).toBeNull();
    expect(res.needsMultiController).toBe(false);
    expect(res.reason).toMatch(/positive number/i);
  });

  it('negative pixels → reason, no selection', () => {
    const res = selectController(-100, CONTROLLERS);
    expect(res.controller).toBeNull();
    expect(res.reason).toMatch(/positive number/i);
  });

  it('non-finite pixels → reason, no selection', () => {
    const res = selectController(Number.NaN, CONTROLLERS);
    expect(res.controller).toBeNull();
    expect(res.reason).toMatch(/positive number/i);
  });
});
