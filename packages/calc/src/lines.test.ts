import { describe, expect, it } from 'vitest';
import { composeScreenTotals, fixedLine, marginLine, markupLine } from './lines.js';

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
