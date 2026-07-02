import { describe, expect, it } from 'vitest';
import { selectLcdTiers, type LcdCandidate } from './lcd-tiers.js';

const mk = (over: Partial<LcdCandidate> & { id: string }): LcdCandidate => ({
  model: `M-${over.id}`,
  brand: null,
  sizeIn: null,
  costAud: 0,
  sellAud: 0,
  category: 'screen',
  ...over,
});

describe('selectLcdTiers (AA3b)', () => {
  const candidates: LcdCandidate[] = [
    mk({ id: 'a', model: 'Cheap 43', brand: 'Samsung', sizeIn: 43, costAud: 500, sellAud: 800 }),
    mk({ id: 'b', model: 'Philips 55', brand: 'Philips', sizeIn: 55, costAud: 900, sellAud: 1500 }),
    mk({ id: 'c', model: 'LG 65', brand: 'LG', sizeIn: 65, costAud: 1400, sellAud: 2400 }),
    mk({ id: 'd', model: 'Philips 75', brand: 'Philips', sizeIn: 75, costAud: 2000, sellAud: 3200 }),
  ];

  it('value = cheapest, premium = dearest', () => {
    const { picks } = selectLcdTiers(candidates);
    const value = picks.find((p) => p.tier === 'value')!;
    const premium = picks.find((p) => p.tier === 'premium')!;
    expect(value.candidate.id).toBe('a'); // 800 = cheapest sell
    expect(premium.candidate.id).toBe('d'); // 3200 = dearest sell
  });

  it('recommended = closest size to the target', () => {
    const { picks } = selectLcdTiers(candidates, { targetSizeIn: 56 });
    const rec = picks.find((p) => p.tier === 'recommended')!;
    expect(rec.candidate.id).toBe('b'); // 55 is closest to 56
    expect(rec.rationale).toBe('Best fit / preferred brand');
  });

  it('recommended prefers Philips (mid-priced) when no size data', () => {
    const noSize = candidates.map((c) => mk({ ...c, sizeIn: null }));
    const { picks } = selectLcdTiers(noSize);
    const rec = picks.find((p) => p.tier === 'recommended')!;
    // Preferred-brand candidates are b (1500) & d (3200); mid of the 2-item pool → index 0 → b.
    expect(rec.candidate.brand).toBe('Philips');
    expect(rec.candidate.id).toBe('b');
  });

  it('distinct products across the three tiers when possible', () => {
    const { picks, distinctProducts } = selectLcdTiers(candidates, { targetSizeIn: 56 });
    expect(picks).toHaveLength(3);
    expect(distinctProducts).toBe(3);
    expect(new Set(picks.map((p) => p.candidate.id)).size).toBe(3);
  });

  it('returns tiers in value/recommended/premium order', () => {
    const { picks } = selectLcdTiers(candidates, { targetSizeIn: 56 });
    expect(picks.map((p) => p.tier)).toEqual(['value', 'recommended', 'premium']);
  });

  it('handles a single candidate gracefully (reuses it across tiers)', () => {
    const one = [candidates[0]!];
    const { picks, distinctProducts } = selectLcdTiers(one);
    expect(picks).toHaveLength(3);
    expect(distinctProducts).toBe(1);
    expect(picks.every((p) => p.candidate.id === 'a')).toBe(true);
  });

  it('empty candidate list → no picks', () => {
    expect(selectLcdTiers([])).toEqual({ picks: [], distinctProducts: 0 });
  });

  it('is deterministic across repeated calls', () => {
    const a = selectLcdTiers(candidates, { targetSizeIn: 56 });
    const b = selectLcdTiers(candidates, { targetSizeIn: 56 });
    expect(a.picks.map((p) => p.candidate.id)).toEqual(b.picks.map((p) => p.candidate.id));
  });
});
