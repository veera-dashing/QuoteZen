import { describe, expect, it } from 'vitest';
import { deriveAutoAnswers, evaluateSelectionTree } from './tree-evaluator.js';

describe('tree-evaluator (Phase 1)', () => {
  describe('deriveAutoAnswers', () => {
    it('auto-derives underOneAndHalfSqm, smallDimension and sizeBand from W x H', () => {
      // 1000 x 1000 = 1.0 sqm (< 1.5, smallDimension=true, sizeBand='Less than 4 sqm')
      const derived = deriveAutoAnswers({ widthMm: 1000, heightMm: 1000 });
      expect(derived.underOneAndHalfSqm).toBe('Yes');
      expect(derived.smallDimension).toBe('Yes');
      expect(derived.sizeBand).toBe('Less than 4 sqm');

      // 3000 x 2000 = 6.0 sqm (> 1.5, smallDimension=false, sizeBand='4 to 10 sqm')
      const derivedLarge = deriveAutoAnswers({ widthMm: 3000, heightMm: 2000 });
      expect(derivedLarge.underOneAndHalfSqm).toBe('No');
      expect(derivedLarge.smallDimension).toBe('No');
      expect(derivedLarge.sizeBand).toBe('4 to 10 sqm');
    });

    it('auto-derives serviceAccess from outdoorLocation', () => {
      const front = deriveAutoAnswers({ outdoorLocation: 'On wall (Front Service)' });
      expect(front.serviceAccess).toBe('Front');

      const rear = deriveAutoAnswers({ outdoorLocation: 'On wall (Rear Service)' });
      expect(rear.serviceAccess).toBe('Rear');
    });

    it('auto-derives exact169 from aspectRatioLabel', () => {
      expect(deriveAutoAnswers({ aspectRatioLabel: '16:9' }).exact169).toBe('Yes');
      expect(deriveAutoAnswers({ aspectRatioLabel: '9:16' }).exact169).toBe('No');
    });
  });

  describe('evaluateSelectionTree - Special Overrides', () => {
    it('selects LEDFul FLEX for curved indoor screens (p47)', () => {
      const res = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Quality',
        curved: 'Yes',
        viewingIndoor: '1 to 2 metres',
      });

      expect(res.firedRuleIds).toContain('p47');
      expect(res.recommendedModelFamilies).toContain('FLEX');
      expect(res.curvedRequired).toBe(true);
      expect(res.primaryRecommendationText).toContain('FLEX');
      // r91 curved 1-2m Quality -> P1.5
      expect(res.pitchMaxMm).toBe(1.5);
      expect(res.gobRequired).toBe(true);
    });

    it('selects Muxwave / TGC for transparent indoor screens (p48 / p49)', () => {
      const qualityRes = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Quality',
        transparent: 'Yes',
      });
      expect(qualityRes.firedRuleIds).toContain('p48');
      expect(qualityRes.recommendedModelFamilies).toContain('Muxwave');
      expect(qualityRes.transparentRequired).toBe(true);

      const valueRes = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Value',
        transparent: 'Yes',
      });
      expect(valueRes.firedRuleIds).toContain('p49');
      expect(valueRes.recommendedModelFamilies).toContain('TGC');
      expect(valueRes.transparentRequired).toBe(true);
      // Caveat c68 for TGC hanging frame
      expect(valueRes.caveats.some((c) => c.includes('TGC products are typically hung'))).toBe(true);
    });

    it('selects WallPad double-sided when hanging (p52)', () => {
      const res = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Value',
        indoorLocation: 'Hanging',
        doubleSided: 'Yes',
      });
      expect(res.firedRuleIds).toContain('p52');
      expect(res.recommendedModelFamilies).toContain('WallPad');
    });

    it('selects BM-PRO / Wall-Pro / U-PRO for exact 16:9 (p54)', () => {
      const res = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Quality',
        exact169: 'Yes',
        indoorLocation: 'On a wall',
      });
      expect(res.firedRuleIds).toContain('p54');
      expect(res.recommendedModelFamilies).toContain('BM-PRO');
      expect(res.recommendedModelFamilies).toContain('U-PRO');
    });
  });

  describe('evaluateSelectionTree - Standard Indoor Scenarios', () => {
    it('selects BM / WallPad for standard indoor wall Value (p37)', () => {
      const res = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Value',
        indoorLocation: 'On a wall',
        curved: 'No',
        transparent: 'No',
        underOneAndHalfSqm: 'No',
        smallDimension: 'No',
        exact169: 'No',
        viewingIndoor: '2 to 3 metres',
      });

      expect(res.firedRuleIds).toContain('p37');
      expect(res.recommendedModelFamilies).toContain('BM');
      expect(res.recommendedModelFamilies).toContain('WallPad');
      // r83: 2-3m Value poster -> P2.5
      expect(res.pitchMaxMm).toBe(2.5);
    });

    it('selects BM-Pro / Wall-Pro for standard indoor wall Quality (p38)', () => {
      const res = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Quality',
        indoorLocation: 'On a wall',
        curved: 'No',
        transparent: 'No',
        underOneAndHalfSqm: 'No',
        smallDimension: 'No',
        exact169: 'No',
        viewingIndoor: '1 to 2 metres',
      });

      expect(res.firedRuleIds).toContain('p38');
      expect(res.recommendedModelFamilies).toContain('BM-PRO');
      // r80: 1-2m Quality poster -> P1.5
      expect(res.pitchMaxMm).toBe(1.5);
      expect(res.gobRequired).toBe(true);
    });

    it('behind window without setback requires rear service or HI with caveats (p43 / c67)', () => {
      const res = evaluateSelectionTree({
        environment: 'Indoor',
        priority: 'Value',
        indoorLocation: 'Behind Window',
        canSetBack: 'No',
        smallDimension: 'No',
        directSunlight: 'Yes',
      });

      expect(res.firedRuleIds).toContain('p43');
      expect(res.recommendedModelFamilies).toContain('HI');
      // r95: direct sunlight -> min 3500 nits
      expect(res.minBrightnessNits).toBe(3500);
    });
  });

  describe('evaluateSelectionTree - Outdoor Scenarios', () => {
    it('selects FS-PRO for severe conditions / high availability (p60 / c70)', () => {
      const res = evaluateSelectionTree({
        environment: 'Outdoor',
        priority: 'Quality',
        highAvailability: 'Yes',
        saltAir: 'Yes',
        viewingOutdoor: '3 to 8 metres',
      });

      expect(res.firedRuleIds).toContain('p60');
      expect(res.recommendedModelFamilies).toContain('FS-PRO');
      expect(res.caveats.some((c) => c.includes('redundant power supplies'))).toBe(true);
      expect(res.caveats.some((c) => c.includes('nano-coating'))).toBe(true);
      // r101: 3-8m outdoor -> around P4
      expect(res.pitchMaxMm).toBe(4.5);
    });

    it('enforces 3840Hz refresh rate for photogenic cameras (c74)', () => {
      const res = evaluateSelectionTree({
        environment: 'Outdoor',
        priority: 'Quality',
        photogenic: 'Yes',
        viewingOutdoor: '2 to 3 metres',
      });

      expect(res.minRefreshRateHz).toBe(3840);
      expect(res.caveats.some((c) => c.includes('3840Hz Refresh'))).toBe(true);
    });

    it('enforces 10,000 nits for elevated direct sun (c76)', () => {
      const res = evaluateSelectionTree({
        environment: 'Outdoor',
        priority: 'Quality',
        elevatedSun: 'Yes',
        viewingOutdoor: '8 to 20 metres',
      });

      expect(res.minBrightnessNits).toBe(10000);
      expect(res.caveats.some((c) => c.includes('10,000nits'))).toBe(true);
    });
  });
});
