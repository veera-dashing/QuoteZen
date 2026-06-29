import { describe, expect, it } from 'vitest';
import { round } from '@quotezen/shared';
import { WORKBOOK_DEFAULTS } from './constants.js';
import { fromAud, toAud } from './currency.js';

describe('currency', () => {
  it('converts USD cost to AUD by dividing by the USD rate (Reference Data F3)', () => {
    // 1071 USD/sqm ÷ 0.6845 = 1564.6457... → 1564.65 AUD (half-up)
    expect(round(toAud(1071, 'USD', WORKBOOK_DEFAULTS)).toString()).toBe('1564.65');
  });

  it('AUD converts to itself (rate 1)', () => {
    expect(toAud(100, 'AUD', WORKBOOK_DEFAULTS).toString()).toBe('100');
  });

  it('fromAud is the inverse direction', () => {
    expect(round(fromAud(100, 'NZD', WORKBOOK_DEFAULTS)).toString()).toBe('121');
  });

  it('throws on an unconfigured currency', () => {
    // @ts-expect-error testing runtime guard with an invalid code
    expect(() => toAud(100, 'JPY', WORKBOOK_DEFAULTS)).toThrow(/no rate configured/);
  });
});
