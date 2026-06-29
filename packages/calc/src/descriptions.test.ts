import { describe, expect, it } from 'vitest';
import { describeLcdScreen, describeLedScreen } from './descriptions.js';

describe('describeLedScreen', () => {
  it('builds a full deterministic description', () => {
    expect(
      describeLedScreen({
        productModel: 'OSD320 / OF1.8',
        widthMm: 1120,
        heightMm: 1920,
        ratioLabel: '9:16',
        pixelPitchMm: 1.8,
        resolutionWpx: 602,
        resolutionHpx: 1032,
        serviceAccess: 'Front',
        warrantyName: '3 year warranty',
        locationName: 'Melbourne, VIC',
      }),
    ).toBe(
      'Seen OSD320 / OF1.8 LED Screen (1120 x 1920mm, 9:16 ratio, 1.8mm pitch, 602 x 1032px (621,264px), Front service, 3 year warranty, Melbourne, VIC)',
    );
  });

  it('omits missing clauses and prefixes quantity', () => {
    expect(describeLedScreen({ productModel: 'IF2.5', qty: 3 })).toBe('3 x Seen IF2.5 LED Screen');
  });

  it('is deterministic (same input → same output)', () => {
    const p = { productModel: 'X', widthMm: 1000, heightMm: 1000 };
    expect(describeLedScreen(p)).toBe(describeLedScreen(p));
  });
});

describe('describeLcdScreen', () => {
  it('builds an LCD description', () => {
    expect(describeLcdScreen({ model: 'Philips 98BDL4650D', warrantyName: '3 years', qty: 2 })).toBe(
      '2 x Philips 98BDL4650D (3 years)',
    );
  });
});
