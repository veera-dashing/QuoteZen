import { describe, expect, it } from 'vitest';
import { buildBreakdown, lcdItemGroup, ledLineGroup, type BreakdownScreenInput } from './breakdown.js';

/** Review-page breakdown by type — pure grouping + allocation rules (no DB). */
describe('ledLineGroup', () => {
  it.each([
    ['screen_mediaplayer', 'LED supply — IAF250 / WALL-PRO2.5', 'screen'],
    ['screen_mediaplayer', 'Spares', 'screen'],
    ['screen_mediaplayer', 'Controller — MCTRL300', 'screen'],
    ['screen_mediaplayer', 'LED peripheral — Light sensor', 'screen'],
    ['screen_mediaplayer', 'Mediaplayer — SeenCMP Mediaplayer', 'mediaplayer'],
    ['screen_mediaplayer', 'Mediaplayer (none)', 'mediaplayer'],
    ['screen_mediaplayer', 'Peripheral — 4G module', 'mediaplayer'],
    ['frame_trim', 'Frame — Bolt-to-floor', 'frame'],
    ['frame_trim', 'GOB — included in product price', 'frame'],
    ['services', 'Freight', 'freight'],
    ['services', 'Local delivery', 'freight'],
    ['services', 'Warehouse', 'freight'],
    ['services', 'Install base cost', 'labour'],
    ['services', 'Mediaplayer configuration', 'labour'],
    ['services', 'Project management', 'labour'],
    ['services', 'Install, labour & freight', 'labour'],
    ['services', 'Engineering', 'other'],
    [null, 'Something new', 'other'],
  ])('%s / %s → %s', (category, label, group) => {
    expect(ledLineGroup(category, label)).toBe(group);
  });
});

describe('lcdItemGroup', () => {
  it.each([
    ['display', 'screen'],
    ['mediaplayer', 'mediaplayer'],
    ['bracket', 'frame'],
    ['location_fee', 'freight'],
    ['install', 'labour'],
    ['labour', 'labour'],
    ['warranty', 'other'],
  ])('%s → %s', (itemType, group) => {
    expect(lcdItemGroup(itemType)).toBe(group);
  });
});

describe('buildBreakdown', () => {
  const led: BreakdownScreenInput = {
    screenId: '1',
    name: 'Window LED',
    type: 'led',
    qty: 2,
    effectiveSell: 1000,
    lines: [
      { group: 'screen', weight: 300, cost: 400 },
      { group: 'mediaplayer', weight: 100, cost: 100 },
      { group: 'labour', weight: 100, cost: 60 },
    ],
  };
  const lcd: BreakdownScreenInput = {
    screenId: '9',
    name: 'Counter LCD',
    type: 'lcd',
    qty: 1,
    effectiveSell: 333.33,
    lines: [
      { group: 'screen', weight: 100, cost: 100 },
      { group: 'freight', weight: 100, cost: 100 },
      { group: 'labour', weight: 100, cost: 100 },
    ],
  };

  it('splits each screen price by its line weights and adds up exactly (to the cent)', () => {
    const b = buildBreakdown([led, lcd], true);
    const [l, c] = b.screens;
    expect(l!.groups.screen.sell).toBe(600);
    expect(l!.groups.mediaplayer.sell).toBe(200);
    expect(l!.groups.labour.sell).toBe(200);
    expect(l!.total).toBe(1000);
    // 333.33 / 3 doesn't divide evenly — the remainder lands on one group, the parts still sum.
    const lcdSum = Object.values(c!.groups).reduce((a, g) => a + g.sell, 0);
    expect(Math.round(lcdSum * 100) / 100).toBe(333.33);
  });

  it('the whole-job column is the sum of the screens, per group and in total', () => {
    const b = buildBreakdown([led, lcd], true);
    expect(b.job.total).toBe(1333.33);
    expect(b.job.groups.labour.sell).toBe(Math.round((200 + b.screens[1]!.groups.labour.sell) * 100) / 100);
    expect(b.job.groups.freight.sell).toBe(b.screens[1]!.groups.freight.sell);
    expect(b.job.groups.screen.cost).toBe(500);
  });

  it('hides cost when the role may not see it', () => {
    const b = buildBreakdown([led], false);
    expect(b.screens[0]!.groups.screen.cost).toBeNull();
    expect(b.job.groups.screen.cost).toBeNull();
    expect(b.screens[0]!.groups.screen.sell).toBe(600);
  });

  it('a fully discounted screen is all zeros; a price with no lines goes to Other', () => {
    const zero = buildBreakdown([{ ...lcd, effectiveSell: 0 }], true);
    expect(zero.screens[0]!.total).toBe(0);
    expect(Object.values(zero.screens[0]!.groups).every((g) => g.sell === 0)).toBe(true);
    const pinned = buildBreakdown([{ ...led, lines: [] }], true);
    expect(pinned.screens[0]!.groups.other.sell).toBe(1000);
  });
});
