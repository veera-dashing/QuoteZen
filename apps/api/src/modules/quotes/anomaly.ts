import { prisma } from '@quotezen/db';
import { effectiveEnvironment, DEFAULT_OUTDOOR_BRIGHTNESS_NITS } from '@quotezen/calc';
import type { QuoteWithChildren } from './repository.js';
import { resolveModedDiscount, getDefaultDiscountPct } from './service.js';

/**
 * Z4 — configurable anomaly-rules engine.
 *
 * The 5 anomaly rules (seeded in Z1 into `anomaly_rules`) are evaluated here against a loaded quote.
 * Every rule is DB-configurable: a row's `enabled` flag turns it off (disabled → NO findings), and its
 * `paramNum` supplies the threshold (falling back to the seed default when absent). A rule's stored
 * `severity` ('block' | 'warn') maps to a validation severity: **'block' → 'error'** (gates
 * finalisation) and **'warn' → 'warning'** (advisory).
 *
 * Every check is DEFENSIVE, mirroring the calc validation philosophy: when the data a rule needs is
 * missing on the quote/screen, that rule is SKIPPED for that screen (never a false positive). A BLOCK
 * rule therefore only ever fires on data it could fully evaluate.
 */

/**
 * A single anomaly finding — quote-level, optionally tied to a screen. `severity` covers the Z4
 * anomaly rules ('error' | 'warning') plus AA6a advisories which may be purely informational ('info',
 * never blocking, not tallied as a warning). Z4's own findings only ever use 'error' | 'warning'.
 */
export interface AnomalyFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** The LED/LCD screen id this finding relates to (when the rule is per-screen). */
  screenId?: string;
}

/** The 5 rule keys (Z1 seed). */
type AnomalyKey =
  | 'nonstandard_cabinet'
  | 'discount_over_cap_aplus'
  | 'outdoor_low_nit'
  | 'air_freight_short_lead'
  | 'custom_engineering';

/** Seed-default thresholds (used when a rule row has no `paramNum`), so the engine is never param-less. */
const DEFAULT_PARAMS: Record<AnomalyKey, number> = {
  nonstandard_cabinet: 0, // no threshold — geometric check
  discount_over_cap_aplus: 12, // percent
  outdoor_low_nit: 2500, // nits
  air_freight_short_lead: 5, // weeks
  custom_engineering: 1590, // $ baseline
};

/** An enabled rule row, normalised for evaluation. */
interface RuleRow {
  key: AnomalyKey;
  severity: 'error' | 'warning';
  paramNum: number;
}

/** Map the stored 'block'|'warn' onto the validation severity ('block' → 'error', 'warn' → 'warning'). */
const toSeverity = (stored: string): 'error' | 'warning' => (stored === 'block' ? 'error' : 'warning');

/** Load the enabled, non-deprecated anomaly rules into a map by key (disabled rows are omitted). */
const loadEnabledRules = async (): Promise<Map<AnomalyKey, RuleRow>> => {
  const rows = await prisma.anomalyRule.findMany({ where: { enabled: true, deprecated: false } });
  const map = new Map<AnomalyKey, RuleRow>();
  for (const r of rows) {
    const key = r.key as AnomalyKey;
    if (!(key in DEFAULT_PARAMS)) continue; // ignore unknown keys defensively
    const paramNum = r.paramNum != null ? Number(r.paramNum) : DEFAULT_PARAMS[key];
    map.set(key, { key, severity: toSeverity(r.severity), paramNum });
  }
  return map;
};

/**
 * Whether snapping `desired` to whole cabinets of `unit` needs a CUT cabinet — mirroring the config
 * engine's `cutCabinetSuggested` logic (packages/calc `buildOption`): snap to the NEAREST whole
 * cabinet count, and treat the leftover fraction of a cabinet beyond `threshold` (default 0.25, the
 * engine's `cutThreshold`) as a cut cabinet. This matches how the engine determines cut cabinets, so
 * an opening that lands close to a whole-cabinet grid is NOT flagged (avoids false blocks).
 */
const CUT_THRESHOLD = 0.25;
const needsCutCabinet = (desired: number, unit: number): boolean => {
  if (unit <= 0) return false;
  const count = Math.max(1, Math.round(desired / unit));
  const snapped = count * unit;
  const remainder = Math.abs(desired - snapped) / unit;
  return remainder > CUT_THRESHOLD;
};

/** Case-insensitive "this freight option is by AIR" test. */
const isAirFreight = (name: string | null | undefined): boolean =>
  name != null && /air/i.test(name);

/**
 * Evaluate all enabled anomaly rules against a loaded quote (the getQuote result). Returns quote-level
 * findings; per-screen rules carry a `screenId`. Disabled rules contribute nothing. Every rule is
 * defensive — missing data ⇒ the rule is skipped for that screen (never a false finding).
 */
export const evaluateAnomalies = async (quote: QuoteWithChildren): Promise<AnomalyFinding[]> => {
  const rules = await loadEnabledRules();
  if (rules.size === 0) return [];

  const findings: AnomalyFinding[] = [];

  // ── nonstandard_cabinet (block → error): a LED screen that is not a whole-cabinet fit (cut cabinet).
  // A cut cabinet = the desired W or H is not an integer multiple of the product's cabinet dimension.
  // Needs both a product (with cabinet dims) and stored desired dims — otherwise skip (never a false block).
  const cabinetRule = rules.get('nonstandard_cabinet');
  if (cabinetRule) {
    for (const s of quote.ledScreens) {
      const p = s.ledProduct;
      const cabW = p?.minCabinetWMm ?? null;
      const cabH = p?.minCabinetHMm ?? null;
      const w = s.desiredWidthMm ?? null;
      const h = s.desiredHeightMm ?? null;
      if (p == null || cabW == null || cabH == null || cabW <= 0 || cabH <= 0 || w == null || h == null) {
        continue; // insufficient data → skip (defensive)
      }
      // rotateCabinets swaps the cabinet grid orientation (mirrors the config engine).
      const gridW = s.rotateCabinets ? cabH : cabW;
      const gridH = s.rotateCabinets ? cabW : cabH;
      if (needsCutCabinet(w, gridW) || needsCutCabinet(h, gridH)) {
        findings.push({
          rule: cabinetRule.key,
          severity: cabinetRule.severity,
          message: `Non-standard cabinet size: ${w}×${h}mm needs a cut cabinet for ${p.model} (${gridW}×${gridH}mm cabinet) — request product manager review.`,
          screenId: s.id.toString(),
        });
      }
    }
  }

  // ── discount_over_cap_aplus (warn → warning): quote discount > paramNum% AND client tier is 'A+'.
  const discountRule = rules.get('discount_over_cap_aplus');
  if (discountRule) {
    const tier = quote.client?.tier ?? null;
    if (tier === 'A+') {
      // Resolve the EFFECTIVE, mode-adjusted discount (quote → client → system default), as a fraction.
      const { pct } = resolveModedDiscount(quote, await getDefaultDiscountPct());
      if (pct * 100 > discountRule.paramNum) {
        findings.push({
          rule: discountRule.key,
          severity: discountRule.severity,
          message: `Discount ${(pct * 100).toFixed(1)}% exceeds the ${discountRule.paramNum}% cap for an A+ client — manager note required.`,
        });
      }
    }
  }

  // ── outdoor_low_nit (warn → warning): a LED screen that is effectively OUTDOOR with product
  // brightness < paramNum (2500) nits. Outdoor is derived from the product's environment or a
  // brightness heuristic (≥ outdoor_brightness_nits setting → outdoor). Needs a known brightness.
  const nitRule = rules.get('outdoor_low_nit');
  if (nitRule) {
    // The brightness heuristic threshold is DB-configurable (mirrors the config engine's default).
    const outdoorSetting = await prisma.setting.findUnique({ where: { key: 'outdoor_brightness_nits' } });
    const outdoorThreshold = outdoorSetting?.value != null ? Number(outdoorSetting.value) : DEFAULT_OUTDOOR_BRIGHTNESS_NITS;
    for (const s of quote.ledScreens) {
      const p = s.ledProduct;
      const nits = p?.brightnessNits ?? null;
      if (p == null || nits == null) continue; // unknown brightness → skip (defensive)
      const env = effectiveEnvironment(
        (p.environment as 'indoor' | 'outdoor' | null) ?? null,
        nits,
        outdoorThreshold,
      );
      if (env === 'outdoor' && nits < nitRule.paramNum) {
        findings.push({
          rule: nitRule.key,
          severity: nitRule.severity,
          message: `Outdoor screen ${p.model} is ${nits} nits, below the ${nitRule.paramNum} nit threshold — confirm sun exposure with a site photo.`,
          screenId: s.id.toString(),
        });
      }
    }
  }

  // ── air_freight_short_lead (block → error per seed): a LED screen using AIR freight with a lead
  // time < paramNum weeks (× 7 days). Lead time = manufacturer leadTimeDays + lead_time_buffer_days.
  // Skip when the freight method or the lead time is unknown (never a false block).
  const airRule = rules.get('air_freight_short_lead');
  if (airRule) {
    const bufferSetting = await prisma.setting.findUnique({ where: { key: 'lead_time_buffer_days' } });
    const bufferDays = bufferSetting?.value != null ? Number(bufferSetting.value) : 0;
    const thresholdDays = airRule.paramNum * 7;
    for (const s of quote.ledScreens) {
      const freightName = s.freightOption?.name ?? null;
      if (!isAirFreight(freightName)) continue; // not air (or unknown) → skip
      const mfrLead = s.ledProduct?.manufacturer?.leadTimeDays ?? null;
      if (mfrLead == null) continue; // unknown lead time → skip (defensive)
      const leadDays = mfrLead + bufferDays;
      if (leadDays < thresholdDays) {
        findings.push({
          rule: airRule.key,
          severity: airRule.severity,
          message: `Air freight (${freightName}) with a ${leadDays}-day lead time is under the ${airRule.paramNum}-week (${thresholdDays}-day) minimum — change freight method or push the go-live date.`,
          screenId: s.id.toString(),
        });
      }
    }
  }

  // ── custom_engineering (warn → warning): a LED screen with a real engineering option selected
  // (not the "No Engineering" option) → flag for engineer review, surfacing the $ baseline (paramNum).
  const engRule = rules.get('custom_engineering');
  if (engRule) {
    for (const s of quote.ledScreens) {
      const eng = s.engineering ?? null;
      if (eng == null) continue; // no engineering selected → skip
      if (/no engineering/i.test(eng.name)) continue; // the explicit "No Engineering" option → not custom
      findings.push({
        rule: engRule.key,
        severity: engRule.severity,
        message: `Custom engineering selected (${eng.name}) — flag for engineer review (+$${engRule.paramNum} baseline).`,
        screenId: s.id.toString(),
      });
    }
  }

  return findings;
};
