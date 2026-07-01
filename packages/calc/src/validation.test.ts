import { describe, expect, it } from 'vitest';
import { canFinalise, validateScreen, validateLcdScreen } from './validation.js';

describe('validateScreen', () => {
  it('requires GOB when pitch < 2.5mm and none selected (error, blocks finalise)', () => {
    const f = validateScreen({ pixelPitchMm: 1.8, gobSelected: false });
    expect(f.find((x) => x.rule === 'GOB_REQUIRED')?.severity).toBe('error');
    expect(canFinalise(f)).toBe(false);
  });

  it('no GOB finding when fine pitch already has GOB', () => {
    const f = validateScreen({ pixelPitchMm: 1.8, gobSelected: true });
    expect(f.some((x) => x.rule === 'GOB_REQUIRED')).toBe(false);
  });

  it('coarse pitch needs no GOB', () => {
    const f = validateScreen({ pixelPitchMm: 4, gobSelected: false });
    expect(f.some((x) => x.rule.startsWith('GOB'))).toBe(false);
  });

  it("returns 'cannot_evaluate' when pitch is unknown (never a false error)", () => {
    const f = validateScreen({ pixelPitchMm: null });
    expect(f.find((x) => x.rule === 'GOB_PITCH')?.severity).toBe('cannot_evaluate');
    expect(canFinalise(f)).toBe(true);
  });

  it('outdoor LED requires sensor + multifunction card + high-temp player', () => {
    const f = validateScreen({ pixelPitchMm: 4, environment: 'outdoor' });
    const rules = f.map((x) => x.rule);
    expect(rules).toContain('OUTDOOR_BRIGHTNESS_SENSOR');
    expect(rules).toContain('OUTDOOR_MULTIFUNCTION_CARD');
    expect(rules).toContain('OUTDOOR_HIGH_TEMP_PLAYER');
    expect(canFinalise(f)).toBe(false);
  });

  it('outdoor LED with all deps present passes', () => {
    const f = validateScreen({
      pixelPitchMm: 4,
      environment: 'outdoor',
      hasBrightnessSensor: true,
      hasMultifunctionCard: true,
      hasHighTempMediaplayer: true,
    });
    expect(f.some((x) => x.rule.startsWith('OUTDOOR'))).toBe(false);
  });

  it('flags pixel count exceeding controller capacity', () => {
    const f = validateScreen({ pixelPitchMm: 4, totalPixels: 3_000_000, controllerMaxPixels: 2_600_000 });
    expect(f.find((x) => x.rule === 'CONTROLLER_PIXELS_EXCEEDED')?.severity).toBe('error');
  });

  it('flags screen exceeding frame dimensions', () => {
    const f = validateScreen({ pixelPitchMm: 4, widthMm: 2000, frameMaxWidthMm: 1920 });
    expect(f.some((x) => x.rule === 'FRAME_WIDTH_EXCEEDED')).toBe(true);
  });
});

describe('validateLcdScreen (X1)', () => {
  it('errors when there are items but no display panel (blocks finalise)', () => {
    const f = validateLcdScreen({
      orientation: 'L',
      items: [{ itemType: 'bracket' }, { itemType: 'mediaplayer' }],
    });
    expect(f.find((x) => x.rule === 'LCD_DISPLAY_REQUIRED')?.severity).toBe('error');
    expect(canFinalise(f)).toBe(false);
  });

  it("returns 'cannot_evaluate' (not an error) when the screen has zero items", () => {
    const f = validateLcdScreen({ orientation: 'L', items: [] });
    expect(f.find((x) => x.rule === 'LCD_DISPLAY_REQUIRED')?.severity).toBe('cannot_evaluate');
    expect(canFinalise(f)).toBe(true);
  });

  it('warns when a display is present but no mediaplayer and no built-in signal', () => {
    const f = validateLcdScreen({
      orientation: 'L',
      items: [
        { itemType: 'display', displayId: '5', description: 'Samsung QM55R 55" UHD' },
        { itemType: 'bracket' },
      ],
    });
    expect(f.find((x) => x.rule === 'LCD_NO_MEDIAPLAYER')?.severity).toBe('warning');
    expect(canFinalise(f)).toBe(true);
  });

  it('does not warn about mediaplayer when the display has a built-in player (chromecast/android/built-in)', () => {
    for (const desc of ['Sony Bravia with Chromecast', 'Philips Android 4K display', 'LCD with built-in player']) {
      const f = validateLcdScreen({
        orientation: 'L',
        items: [
          { itemType: 'display', displayId: '5', description: desc },
          { itemType: 'bracket' },
        ],
      });
      expect(f.some((x) => x.rule === 'LCD_NO_MEDIAPLAYER'), desc).toBe(false);
    }
  });

  it("uses 'cannot_evaluate' for the mediaplayer rule when the display model is unknown", () => {
    const f = validateLcdScreen({
      orientation: 'L',
      items: [{ itemType: 'display', displayId: '5' }, { itemType: 'bracket' }],
    });
    expect(f.find((x) => x.rule === 'LCD_NO_MEDIAPLAYER')?.severity).toBe('cannot_evaluate');
    expect(canFinalise(f)).toBe(true);
  });

  it('warns when a display is present but no bracket', () => {
    const f = validateLcdScreen({
      orientation: 'L',
      items: [
        { itemType: 'display', displayId: '5', description: 'Samsung with Chromecast' },
        { itemType: 'mediaplayer' },
      ],
    });
    expect(f.find((x) => x.rule === 'LCD_NO_BRACKET')?.severity).toBe('warning');
  });

  it('warns when orientation is not specified', () => {
    const f = validateLcdScreen({
      orientation: null,
      items: [{ itemType: 'display', displayId: '5', description: 'Samsung with Chromecast' }, { itemType: 'bracket' }, { itemType: 'mediaplayer' }],
    });
    expect(f.find((x) => x.rule === 'LCD_NO_ORIENTATION')?.severity).toBe('warning');
  });

  it('a fully-specified clean LCD screen has no error and can finalise', () => {
    const f = validateLcdScreen({
      orientation: 'L',
      items: [
        { itemType: 'display', displayId: '5', description: 'Samsung QM55R 55" UHD' },
        { itemType: 'mediaplayer', description: 'BrightSign XT244' },
        { itemType: 'bracket', description: 'Tilt mount' },
      ],
    });
    expect(f.some((x) => x.severity === 'error')).toBe(false);
    expect(canFinalise(f)).toBe(true);
  });
});
