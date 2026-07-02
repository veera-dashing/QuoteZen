/**
 * AA6a — deterministic freight-mode advisory (Group F).
 *
 * A PURE lead-time-vs-install-deadline comparison used to advise whether SEA freight leaves enough
 * time before the requested go-live / shipping date, or whether AIR should be considered instead.
 * This is ADVISORY ONLY — it never changes freight pricing or the selected freight option. The API
 * layer feeds it real dates + the quote's manufacturing lead times; keeping the arithmetic here makes
 * it trivially unit-testable.
 *
 * Model (documented, deterministic):
 *   availableDays = shipDate − today (whole days; may be negative if the date has passed)
 *   neededDays    = maxManufacturerLeadTimeDays + leadTimeBufferDays + SEA_TRANSIT_DAYS
 * If availableDays < neededDays the sea path is too tight → recommend AIR. Otherwise SEA is fine.
 *
 * The sea-transit constant is a documented planning assumption for the AU market (China/Asia → AU
 * ocean freight, port-to-door, is commonly ~30–45 days; we use 35 as a mid-point). It is NOT sourced
 * from the workbook (the workbook prices freight but does not model transit time) and is intentionally
 * a named constant here so it can be tuned in one place.
 */

/** Documented planning assumption: door-to-door SEA transit for AU imports (days). */
export const SEA_TRANSIT_DAYS = 35;

export type FreightMode = 'air' | 'sea';

export interface FreightModeInput {
  /** The requested shipping / install-deadline date. */
  shipDate: Date;
  /** "Today" (the evaluation date) — injected so the comparison is deterministic/testable. */
  today: Date;
  /** Max manufacturing lead time across the quote's LED screens (days). 0/absent → treated as 0. */
  maxManufacturerLeadTimeDays: number;
  /** The org-wide lead-time buffer (days) — the existing `lead_time_buffer_days` setting. */
  leadTimeBufferDays: number;
  /** Override the sea-transit assumption (days); defaults to {@link SEA_TRANSIT_DAYS}. */
  seaTransitDays?: number;
}

export interface FreightModeResult {
  /** The recommended freight mode given the deadline. */
  recommendedMode: FreightMode;
  /** Whole days between today and the ship date (negative if the date has passed). */
  availableDays: number;
  /** Days the SEA path needs: manufacturing lead + buffer + sea transit. */
  neededDays: number;
  /** Convenience flag: the sea path is too tight (availableDays < neededDays). */
  tight: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to` (positive when `to` is later). */
const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);

/**
 * Recommend a freight mode from a lead-time-vs-deadline comparison. Deterministic + pure. Negative
 * `maxManufacturerLeadTimeDays` / `leadTimeBufferDays` are clamped to 0 defensively.
 */
export const recommendFreightMode = (input: FreightModeInput): FreightModeResult => {
  const availableDays = daysBetween(input.today, input.shipDate);
  const lead = Math.max(0, input.maxManufacturerLeadTimeDays);
  const buffer = Math.max(0, input.leadTimeBufferDays);
  const seaTransit = input.seaTransitDays ?? SEA_TRANSIT_DAYS;
  const neededDays = lead + buffer + seaTransit;
  const tight = availableDays < neededDays;
  return {
    recommendedMode: tight ? 'air' : 'sea',
    availableDays,
    neededDays,
    tight,
  };
};
