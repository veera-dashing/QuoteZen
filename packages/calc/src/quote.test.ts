import { describe, expect, it } from 'vitest';
import { aggregateQuote } from './quote.js';

describe('aggregateQuote', () => {
  it('separates equipment, services and recurring totals', () => {
    const t = aggregateQuote([
      { kind: 'equipment', extendedSell: 9900 },
      { kind: 'services', extendedSell: 2480 },
      { kind: 'recurring', extendedSell: 395 },
    ]);
    expect(t.equipment.toString()).toBe('9900');
    expect(t.services.toString()).toBe('2480');
    expect(t.recurring.toString()).toBe('395');
    expect(t.upfront.toString()).toBe('12380');
    expect(t.grandTotal.toString()).toBe('12380');
  });

  it('applies a reseller markup to the up-front total only', () => {
    const t = aggregateQuote(
      [
        { kind: 'equipment', extendedSell: 10000 },
        { kind: 'recurring', extendedSell: 400 },
      ],
      0.1,
    );
    expect(t.upfront.toString()).toBe('10000');
    expect(t.grandTotal.toString()).toBe('11000'); // recurring untouched
    expect(t.recurring.toString()).toBe('400');
  });

  it('rejects a negative reseller markup', () => {
    expect(() => aggregateQuote([], -0.1)).toThrow();
  });
});
