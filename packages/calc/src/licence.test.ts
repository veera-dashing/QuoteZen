import { describe, expect, it } from 'vitest';
import { annualLicence, type LicenceRates } from './licence.js';

const LOW: LicenceRates = { siteFee: 270, perScreen: 125, interactiveUplift: 100 };
const HIGH: LicenceRates = { siteFee: 165, perScreen: 95, interactiveUplift: 100 };

describe('annualLicence', () => {
  it('first low-volume screen = site fee + per-screen ($395)', () => {
    expect(annualLicence({ screenCount: 1, interactiveCount: 0, rates: LOW }).toString()).toBe(
      '395',
    );
  });

  it('first interactive low-volume screen = $495', () => {
    expect(annualLicence({ screenCount: 1, interactiveCount: 1, rates: LOW }).toString()).toBe(
      '495',
    );
  });

  it('three screens share one site fee (270 + 3×125 = 645)', () => {
    expect(annualLicence({ screenCount: 3, interactiveCount: 0, rates: LOW }).toString()).toBe(
      '645',
    );
  });

  it('high-volume tier uses the lower rates (165 + 95 = 260)', () => {
    expect(annualLicence({ screenCount: 1, interactiveCount: 0, rates: HIGH }).toString()).toBe(
      '260',
    );
  });

  it('zero screens cost nothing', () => {
    expect(annualLicence({ screenCount: 0, interactiveCount: 0, rates: LOW }).toString()).toBe('0');
  });

  it('rejects more interactive than total screens', () => {
    expect(() => annualLicence({ screenCount: 1, interactiveCount: 2, rates: LOW })).toThrow();
  });
});
