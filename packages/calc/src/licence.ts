import { Decimal, d, mul, sum } from '@quotezen/shared';

/**
 * SeenCMP licence & support annual recurring cost (Licence & Support tab).
 *
 * The site fee is charged once per deployment; each screen then adds the per-screen licence, and
 * interactive screens add an uplift. Low-volume defaults: site $270, per-screen $125, interactive
 * uplift $100 → first screen $395, interactive first screen $495, each subsequent screen $125.
 */
export interface LicenceRates {
  siteFee: number;
  perScreen: number;
  interactiveUplift: number;
}

export interface LicenceInput {
  screenCount: number;
  interactiveCount: number;
  rates: LicenceRates;
}

export const annualLicence = ({ screenCount, interactiveCount, rates }: LicenceInput): Decimal => {
  if (screenCount < 0 || interactiveCount < 0) {
    throw new RangeError('licence: counts must be non-negative');
  }
  if (interactiveCount > screenCount) {
    throw new RangeError('licence: interactiveCount cannot exceed screenCount');
  }
  if (screenCount === 0) return d(0);
  return sum([
    rates.siteFee,
    mul(rates.perScreen, screenCount),
    mul(rates.interactiveUplift, interactiveCount),
  ]);
};
