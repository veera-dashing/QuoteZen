import { describe, it, expect } from 'vitest';
import { recommendFreightMode, SEA_TRANSIT_DAYS } from './freight.js';

describe('recommendFreightMode (AA6a)', () => {
  const today = new Date('2026-07-02T00:00:00Z');

  it('recommends AIR when the go-live date is too tight for sea', () => {
    // needed = 45 lead + 3 buffer + 35 sea = 83 days; only 30 days available.
    const r = recommendFreightMode({
      shipDate: new Date('2026-08-01T00:00:00Z'),
      today,
      maxManufacturerLeadTimeDays: 45,
      leadTimeBufferDays: 3,
    });
    expect(r.recommendedMode).toBe('air');
    expect(r.tight).toBe(true);
    expect(r.availableDays).toBe(30);
    expect(r.neededDays).toBe(45 + 3 + SEA_TRANSIT_DAYS);
  });

  it('recommends SEA when there is ample lead time', () => {
    // 180 days out; needed = 45 + 3 + 35 = 83.
    const r = recommendFreightMode({
      shipDate: new Date('2026-12-29T00:00:00Z'),
      today,
      maxManufacturerLeadTimeDays: 45,
      leadTimeBufferDays: 3,
    });
    expect(r.recommendedMode).toBe('sea');
    expect(r.tight).toBe(false);
    expect(r.availableDays).toBeGreaterThanOrEqual(r.neededDays);
  });

  it('treats exactly-enough days as SEA (boundary: available == needed)', () => {
    const needed = 45 + 3 + SEA_TRANSIT_DAYS; // 83
    const shipDate = new Date(today.getTime() + needed * 24 * 60 * 60 * 1000);
    const r = recommendFreightMode({
      shipDate,
      today,
      maxManufacturerLeadTimeDays: 45,
      leadTimeBufferDays: 3,
    });
    expect(r.availableDays).toBe(needed);
    expect(r.recommendedMode).toBe('sea'); // < is the tight test, so == is fine
  });

  it('recommends AIR when the deadline has already passed (negative available days)', () => {
    const r = recommendFreightMode({
      shipDate: new Date('2026-06-01T00:00:00Z'),
      today,
      maxManufacturerLeadTimeDays: 0,
      leadTimeBufferDays: 0,
    });
    expect(r.availableDays).toBeLessThan(0);
    expect(r.recommendedMode).toBe('air');
  });

  it('clamps negative lead/buffer to 0 (defensive)', () => {
    const r = recommendFreightMode({
      shipDate: new Date('2026-08-20T00:00:00Z'),
      today,
      maxManufacturerLeadTimeDays: -10,
      leadTimeBufferDays: -5,
    });
    expect(r.neededDays).toBe(SEA_TRANSIT_DAYS);
  });
});
