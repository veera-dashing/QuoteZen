import { describe, expect, it } from 'vitest';
import { canFinalise, validateScreen } from './validation.js';

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
