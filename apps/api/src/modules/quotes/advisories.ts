import { prisma } from '@quotezen/db';
import { recommendFreightMode } from '@quotezen/calc';
import type { QuoteWithChildren } from './repository.js';
import type { AnomalyFinding } from './anomaly.js';

/**
 * AA6a — commercial-intake ADVISORY findings (Group F, no-pricing-risk parts).
 *
 * These are quote-level advisories folded into the same validation aggregate as the Z4 anomaly rules
 * (so the Review Validation card renders them the same way), but they are NEVER blocking — always
 * 'warning' severity. They do NOT touch pricing or the selected freight option; the freight one is a
 * pure lead-time-vs-deadline recommendation.
 *
 * Reuses the {@link AnomalyFinding} shape so `validateQuote` can concat them into `anomalies`.
 */

/** Default screen-count threshold above which a solutions-engineer review is advised. */
const DEFAULT_SE_SCREEN_THRESHOLD = 10;

const numSetting = async (key: string, fallback: number): Promise<number> => {
  const s = await prisma.setting.findUnique({ where: { key } });
  return s?.value != null ? Number(s.value) : fallback;
};

export const evaluateCommercialAdvisories = async (
  quote: QuoteWithChildren,
): Promise<AnomalyFinding[]> => {
  const findings: AnomalyFinding[] = [];

  // ── SOLUTIONS_ENGINEER_REVIEW (warning): the flag is set OR the total screen count exceeds the
  //    configurable threshold. Advisory only — never blocks.
  const screenCount = quote.ledScreens.length + quote.lcdScreens.length;
  const seThreshold = await numSetting('solutions_engineer_screen_threshold', DEFAULT_SE_SCREEN_THRESHOLD);
  const flagged = quote.needsSolutionsEngineer === true;
  const overThreshold = screenCount > seThreshold;
  if (flagged || overThreshold) {
    const trigger = flagged
      ? overThreshold
        ? `flagged on the quote and the ${screenCount} screens exceed the ${seThreshold}-screen threshold`
        : 'flagged on the quote'
      : `the ${screenCount} screens exceed the ${seThreshold}-screen threshold`;
    findings.push({
      rule: 'SOLUTIONS_ENGINEER_REVIEW',
      severity: 'warning',
      message: `Solutions engineer review advised — ${trigger}.`,
    });
  }

  // ── FREIGHT_MODE_RECOMMENDATION (warning): a lead-time-vs-install-deadline check. Only evaluable
  //    when a requested shipping date is set. Advisory only — does NOT change freight pricing or the
  //    selected freight option.
  if (quote.requestedShippingDate) {
    // Max manufacturing lead time across the quote's LED screens (0 when none known).
    const maxLead = quote.ledScreens.reduce<number>((max, s) => {
      const lead = s.ledProduct?.manufacturer?.leadTimeDays ?? null;
      return lead != null ? Math.max(max, lead) : max;
    }, 0);
    const bufferDays = await numSetting('lead_time_buffer_days', 0);
    const result = recommendFreightMode({
      shipDate: quote.requestedShippingDate,
      today: new Date(),
      maxManufacturerLeadTimeDays: maxLead,
      leadTimeBufferDays: bufferDays,
    });
    if (result.recommendedMode === 'air') {
      findings.push({
        rule: 'FREIGHT_MODE_RECOMMENDATION',
        severity: 'warning',
        message:
          `Install deadline is tight — consider air freight. ` +
          `${result.availableDays} day(s) available vs ~${result.neededDays} needed for sea ` +
          `(max lead ${maxLead}d + buffer ${bufferDays}d + sea transit).`,
      });
    } else {
      findings.push({
        rule: 'FREIGHT_MODE_RECOMMENDATION',
        severity: 'info',
        message:
          `Sea freight fits the schedule — ${result.availableDays} day(s) available vs ~${result.neededDays} needed.`,
      });
    }
  }

  return findings;
};
