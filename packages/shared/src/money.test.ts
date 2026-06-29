import { describe, expect, it } from 'vitest';
import {
  applyMargin,
  applyMarkup,
  d,
  div,
  marginOf,
  mul,
  round,
  sum,
  toMoneyString,
} from './money.js';

describe('money', () => {
  it('sums numerics and ignores null/undefined', () => {
    expect(sum([1, '2.5', d(3), null, undefined]).toString()).toBe('6.5');
    expect(sum([]).toString()).toBe('0');
  });

  it('multiplies without floating-point drift', () => {
    // 0.1 * 0.2 in IEEE754 is 0.020000000000000004; Decimal keeps it exact.
    expect(mul('0.1', '0.2').toString()).toBe('0.02');
  });

  it('throws on divide by zero', () => {
    expect(() => div(1, 0)).toThrow(/division by zero/);
  });

  it('applyMargin: sell = cost / (1 - margin)', () => {
    // LED margin 0.33 → cost 100 → 149.2537...
    expect(round(applyMargin(100, 0.33)).toString()).toBe('149.25');
    // LCD margin 0.30 → cost 6310 → 9014.28...
    expect(round(applyMargin(6310, 0.3)).toString()).toBe('9014.29');
  });

  it('applyMargin rejects out-of-range margins', () => {
    expect(() => applyMargin(100, 1)).toThrow();
    expect(() => applyMargin(100, -0.1)).toThrow();
  });

  it('applyMarkup multiplies (Philips markup 1.4)', () => {
    expect(applyMarkup(500, 1.4).toString()).toBe('700');
  });

  it('marginOf is the inverse of applyMargin', () => {
    const sell = applyMargin(100, 0.3);
    expect(round(marginOf(100, sell), 4).toString()).toBe('0.3');
    expect(marginOf(100, 0).toString()).toBe('0');
  });

  it('round uses half-up', () => {
    expect(round('2.345').toString()).toBe('2.35');
    expect(round('2.344').toString()).toBe('2.34');
  });

  it('toMoneyString always has 2dp', () => {
    expect(toMoneyString(5)).toBe('5.00');
    expect(toMoneyString('3.1')).toBe('3.10');
  });
});
