import { describe, expect, it } from 'vitest';
import type { IntakeExtraction } from '../ai/extract.js';
import { buildIntakeNotes, matchLocationName, normalizeClientName } from './intake.js';

describe('normalizeClientName (duplicate-safe client matching)', () => {
  it('ignores legal suffixes, case, punctuation and Zoho "(Sample)" tags', () => {
    expect(normalizeClientName('Harbour Retail Pty Ltd')).toBe('harbour retail');
    expect(normalizeClientName('HARBOUR RETAIL')).toBe('harbour retail');
    expect(normalizeClientName('Harbour Retail (Sample)')).toBe('harbour retail');
    expect(normalizeClientName('Accent Group Pty. Ltd.')).toBe('accent group');
  });

  it('keeps genuinely different names apart', () => {
    expect(normalizeClientName('Accent Group')).not.toBe(normalizeClientName('Accent Retail'));
    expect(normalizeClientName('Cotton On')).toBe('cotton on');
  });
});

describe('matchLocationName', () => {
  const locations = [
    { id: 1n, name: 'Perth, WA' },
    { id: 2n, name: 'Melbourne, VIC' },
    { id: 3n, name: 'Gold Coast, QLD' },
  ];

  it('matches the city part of "City, ST", case-insensitively', () => {
    expect(matchLocationName(locations, 'perth', 'WA')?.id).toBe(1n);
    expect(matchLocationName(locations, 'Gold Coast', null)?.id).toBe(3n);
  });

  it('returns null when the city is unknown or missing (estimator picks it)', () => {
    expect(matchLocationName(locations, 'Darwin', 'NT')).toBeNull();
    expect(matchLocationName(locations, null, 'WA')).toBeNull();
  });
});

describe('buildIntakeNotes', () => {
  const extraction = {
    installDeadlineText: 'March 2027',
    missingInfo: ['State'],
    conflicts: ['width: 2 m vs 2.4 m'],
  } as unknown as IntakeExtraction;

  it('summarises deadline, gaps, conflicts and screens left for the estimator', () => {
    const notes = buildIntakeNotes(
      'Accent – entrance LED',
      extraction,
      [
        { name: 'Entrance', status: 'added', screenId: '1', product: 'FLX-2.5', qty: 1 },
        { name: 'Menu boards', status: 'needs_estimator', reason: 'LCD display selection is not automated yet' },
      ],
      'gemini-test',
    );
    expect(notes).toContain('Zoho deal "Accent – entrance LED"');
    expect(notes).toContain('Install deadline: March 2027');
    expect(notes).toContain('Missing info: State');
    expect(notes).toContain('Conflicts: width: 2 m vs 2.4 m');
    expect(notes).toContain('Screen "Menu boards" needs the estimator');
    expect(notes).not.toContain('"Entrance" needs');
  });

  it('never exceeds the 2000-char project-notes column', () => {
    const long = { ...extraction, missingInfo: Array.from({ length: 300 }, (_, i) => `item ${i}`) } as IntakeExtraction;
    expect(buildIntakeNotes('x', long, [], 'm').length).toBeLessThanOrEqual(2000);
  });
});
