import { describe, expect, it } from 'vitest';
import {
  composeScreenTotals,
  fixedLine,
  marginLine,
  markupLine,
  priceSectionsAtMargin,
  roundToTen,
} from './lines.js';

describe('priced lines', () => {
  it('markupLine: sell = cost × markup × qty', () => {
    const line = markupLine('LED supply', 'screen_mediaplayer', 1000, 1.5, 2);
    expect(line.costAud.toString()).toBe('2000');
    expect(line.sellAud.toString()).toBe('3000');
  });

  it('marginLine: sell = cost / (1 - margin)', () => {
    const line = marginLine('Display', 'screen_mediaplayer', 6310, 0.3);
    expect(line.sellAud.toDecimalPlaces(2).toString()).toBe('9014.29');
  });

  it('fixedLine carries explicit cost and sell', () => {
    const line = fixedLine('4G datapack', 'services', 0, 400);
    expect(line.sellAud.toString()).toBe('400');
  });

  it('composeScreenTotals rolls lines into summary buckets', () => {
    const totals = composeScreenTotals([
      markupLine('LED supply', 'screen_mediaplayer', 1000, 1.5),
      markupLine('Controller', 'screen_mediaplayer', 200, 1.5),
      markupLine('Frame', 'frame_trim', 500, 1.5),
      fixedLine('Install', 'services', 800, 1200),
      fixedLine('Freight', 'freight', 100, 150),
    ]);
    // screen+mediaplayer sell = (1000+200)×1.5 = 1800
    expect(totals.screenMediaplayerSell.toString()).toBe('1800');
    expect(totals.frameTrimSell.toString()).toBe('750');
    // services bucket folds in freight: 1200 + 150
    expect(totals.servicesSell.toString()).toBe('1350');
    // total cost = 1000+200+500+800+100 = 2600; total sell = 1800+750+1200+150 = 3900
    expect(totals.totalCost.toString()).toBe('2600');
    expect(totals.totalSell.toString()).toBe('3900');
    // margin = (3900-2600)/3900 = 0.3333
    expect(totals.margin.toString()).toBe('0.3333');
  });
});

describe('priceSectionsAtMargin (workbook (LED 1) J2/K2/L2)', () => {
  it('roundToTen is ROUND(x,-1), half-up', () => {
    expect(roundToTen(4941.75).toString()).toBe('4940');
    expect(roundToTen(2415).toString()).toBe('2420');
    expect(roundToTen(1843.28).toString()).toBe('1840');
  });

  it('quote 560 (FLX-1.86 1120×1920, MSD300): $4,940 supply + $2,410 install = $7,350', () => {
    const priced = priceSectionsAtMargin(
      [
        fixedLine('LED supply', 'screen_mediaplayer', 2742.58, 4113.88),
        fixedLine('Spares', 'screen_mediaplayer', 411.39, 617.08),
        fixedLine('Controller', 'screen_mediaplayer', 157, 235.5),
        fixedLine('Install, labour & freight', 'services', 1615, 2664.75),
      ],
      0.33,
    );
    const totals = composeScreenTotals(priced);
    expect(totals.screenMediaplayerSell.toString()).toBe('4940');
    expect(totals.servicesSell.toString()).toBe('2410');
    expect(totals.totalSell.toString()).toBe('7350');
    // Costs are untouched.
    expect(totals.totalCost.toString()).toBe('4925.97');
  });

  it('quote 559 (IAF250 WALL-PRO1.5 1000×2000, no controller): $6,820 + $1,840 = $8,660', () => {
    const totals = composeScreenTotals(
      priceSectionsAtMargin(
        [
          fixedLine('LED supply', 'screen_mediaplayer', 3973.7, 5960.56),
          fixedLine('Spares', 'screen_mediaplayer', 596.06, 894.08),
          fixedLine('Install, labour & freight', 'services', 1235, 2037.75),
        ],
        0.33,
      ),
    );
    expect(totals.totalSell.toString()).toBe('8660');
  });

  it('itemised lines sum exactly to the rounded section; residual lands on the largest-cost line', () => {
    const priced = priceSectionsAtMargin(
      [
        fixedLine('LED supply', 'screen_mediaplayer', 2742.58, 0),
        fixedLine('Spares', 'screen_mediaplayer', 411.39, 0),
      ],
      0.33,
    );
    expect(priced[1]!.sellAud.toString()).toBe('614.01'); // 411.39 / 0.67, untouched
    expect(priced[0]!.sellAud.plus(priced[1]!.sellAud).toString()).toBe('4710'); // 3153.97/0.67 = 4707.42
  });

  it('a client margin (30%) changes the price; freight folds into the services section', () => {
    const totals = composeScreenTotals(
      priceSectionsAtMargin(
        [fixedLine('Install', 'services', 1000, 0), fixedLine('Freight', 'freight', 400, 0)],
        0.3,
      ),
    );
    expect(totals.servicesSell.toString()).toBe('2000'); // 1400 / 0.7
  });
});
