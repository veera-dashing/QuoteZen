import { describe, expect, it } from 'vitest';
import { buildLcdOrderList, describeLcdScreen, describeLedScreen } from './descriptions.js';

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
  it('defaults to the in-built SeenCMP mediaplayer when no external player is supplied (tab B2)', () => {
    // Updated for the tab-B2 auto-description: the mediaplayer clause always renders (in-built default),
    // and the warranty appears in the body rather than a bare parenthetical.
    expect(describeLcdScreen({ model: 'Philips 98BDL4650D', warrantyName: '3 years', qty: 2 })).toBe(
      '2 x Philips 98BDL4650D with in-built SeenCMP mediaplayer, 3 years',
    );
  });

  it('joins external mediaplayers instead of the in-built default', () => {
    expect(
      describeLcdScreen({
        model: 'Philips 98BDL4650D',
        externalMediaplayers: ['BrightSign XT1144'],
      }),
    ).toBe('Philips 98BDL4650D with BrightSign XT1144');
  });

  it('appends an orientation suffix (Landscape / Portrait)', () => {
    expect(describeLcdScreen({ model: 'LCD', orientation: 'L' })).toBe(
      'LCD with in-built SeenCMP mediaplayer (Landscape)',
    );
    expect(describeLcdScreen({ model: 'LCD', orientation: 'P' })).toBe(
      'LCD with in-built SeenCMP mediaplayer (Portrait)',
    );
  });

  it('surfaces component descriptions and warranty in the body', () => {
    expect(
      describeLcdScreen({
        model: 'Sony BZ40',
        componentDescriptions: ['Tilt bracket'],
        warrantyName: '5 years',
        orientation: 'P',
      }),
    ).toBe('Sony BZ40 with in-built SeenCMP mediaplayer, Tilt bracket, 5 years (Portrait)');
  });

  it('is deterministic (same input → same output)', () => {
    const p = { model: 'X', externalMediaplayers: ['MP1'], orientation: 'L' as const };
    expect(describeLcdScreen(p)).toBe(describeLcdScreen(p));
  });
});

describe('buildLcdOrderList', () => {
  it('builds "N x <item>" joined, skipping zero-qty and empty entries (tab B56)', () => {
    expect(
      buildLcdOrderList([
        { name: 'Philips 98BDL4650D', qty: 2 },
        { name: 'Tilt bracket', qty: 1 },
        { name: 'Dropped', qty: 0 },
        { name: '  ', qty: 3 },
      ]),
    ).toBe('2 x Philips 98BDL4650D, 1 x Tilt bracket');
  });

  it('returns an empty string when there is nothing to order', () => {
    expect(buildLcdOrderList([])).toBe('');
  });
});
