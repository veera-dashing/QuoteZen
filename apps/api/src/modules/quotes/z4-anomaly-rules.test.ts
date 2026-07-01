import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '@quotezen/db';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';

/**
 * Z4 — configurable anomaly-rules engine wired into quote validation.
 *
 * The 5 seeded `anomaly_rules` (Z1) are DB-configurable (enabled + paramNum) and evaluated by
 * `evaluateAnomalies`, folded into `/quotes/:id/validate` (`anomalies[]`, counts, canFinalise) and
 * the `changeStatus` finalisation guardrail. Severity maps: 'block' → 'error', 'warn' → 'warning'.
 *
 * These tests mutate specific anomaly_rules (and one A+ client + one setting) and restore everything
 * in afterAll. Quotes are self-cleaned by a jobReference prefix.
 */
const JOB_PREFIX = `Z4-${process.pid}-`;
let app: FastifyInstance;
let adminToken: string;
let salesToken: string;
let directorToken: string;

/** An LED product with a manufacturer lead time + full geometry/cost, for the air-freight test. */
let leadProductId: string;
/** A whole-cabinet-friendly LED product (for clean screens). */
let cleanProductId: string;
let engineeringOptionId: string;
let noEngineeringOptionId: string;
let airFreightOptionId: string;
let aplusClientId: string;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const login = async (email: string) =>
  (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'demo' } })).json()
    .token as string;

/** Snapshot the current state of an anomaly rule so we can restore it. */
type RuleSnap = { enabled: boolean; severity: string; paramNum: string | null };
const ruleSnaps = new Map<string, RuleSnap>();
const snapshotRule = async (key: string) => {
  const r = await prisma.anomalyRule.findUniqueOrThrow({ where: { key } });
  ruleSnaps.set(key, { enabled: r.enabled, severity: r.severity, paramNum: r.paramNum?.toString() ?? null });
};
const restoreRule = async (key: string) => {
  const s = ruleSnaps.get(key);
  if (!s) return;
  await prisma.anomalyRule.update({
    where: { key },
    data: { enabled: s.enabled, severity: s.severity, paramNum: s.paramNum },
  });
};

const newQuote = async (headers: Record<string, string>, extra: Record<string, unknown> = {}): Promise<string> => {
  const created = await app.inject({
    method: 'POST',
    url: '/quotes',
    headers,
    payload: { jobReference: `${JOB_PREFIX}${Math.floor(Math.random() * 1e9)}`, currencyCode: 'AUD', ...extra },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
};

const addLedScreen = async (
  quoteId: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<number> => {
  const res = await app.inject({ method: 'POST', url: `/quotes/${quoteId}/led-screens`, headers, payload });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  return res.statusCode;
};

const validate = async (quoteId: string, headers: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: `/quotes/${quoteId}/validate`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    canFinalise: boolean;
    counts: { error: number; warning: number; cannotEvaluate: number };
    anomalies: Array<{ rule: string; severity: 'error' | 'warning'; message: string; screenId?: string }>;
  };
};

const approve = (id: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: `/quotes/${id}/status`, headers, payload: { status: 'approved' } });

beforeAll(async () => {
  app = await buildApp(loadConfig());
  adminToken = await login('admin@quotezen.local');
  salesToken = await login('sales@quotezen.local');
  directorToken = await login('director@quotezen.local');

  // Snapshot every rule we might touch.
  for (const key of ['nonstandard_cabinet', 'discount_over_cap_aplus', 'outdoor_low_nit', 'air_freight_short_lead', 'custom_engineering']) {
    await snapshotRule(key);
  }

  // A product with a manufacturer lead time + full geometry/cost (air-freight + clean screens).
  const lead = await prisma.ledProduct.findFirst({
    where: {
      manufacturerId: { not: null },
      manufacturer: { leadTimeDays: { not: null } },
      pixelPitchH: { gte: 2.5 }, // coarse → no GOB error muddying the validation
      minCabinetWMm: { not: null },
      minCabinetHMm: { not: null },
      pixelPitchV: { not: null },
      costPerSqmUsd: { not: null },
      deprecated: false,
    },
    include: { manufacturer: true },
  });
  if (!lead) throw new Error('Expected a coarse LED product with a manufacturer lead time + supply cost');
  leadProductId = lead.id.toString();
  cleanProductId = lead.id.toString();

  const eng = await prisma.engineeringOption.findFirst({ where: { name: { not: { contains: 'No Engineering' } } } });
  const noEng = await prisma.engineeringOption.findFirst({ where: { name: { contains: 'No Engineering' } } });
  if (!eng || !noEng) throw new Error('Expected engineering options (real + "No Engineering") in the catalogue');
  engineeringOptionId = eng.id.toString();
  noEngineeringOptionId = noEng.id.toString();

  const air = await prisma.freightOption.findFirst({ where: { name: { contains: 'Air' } } });
  if (!air) throw new Error('Expected an Air freight option in the catalogue');
  airFreightOptionId = air.id.toString();

  // An A+ client for the discount rule.
  const client = await prisma.client.create({
    data: { name: `${JOB_PREFIX}A+ client`, tier: 'A+' },
  });
  aplusClientId = client.id.toString();
});

afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await prisma.client.deleteMany({ where: { name: { startsWith: JOB_PREFIX } } });
  for (const key of ruleSnaps.keys()) await restoreRule(key).catch(() => undefined);
  await app.close();
  await prisma.$disconnect();
});

describe('Z4 — a disabled rule produces no finding', () => {
  it('custom_engineering disabled → no anomaly, even with a real engineering option', async () => {
    await prisma.anomalyRule.update({ where: { key: 'custom_engineering' }, data: { enabled: false } });
    try {
      const id = await newQuote(bearer(salesToken));
      await addLedScreen(id, bearer(salesToken), {
        ledProductId: Number(cleanProductId),
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        rotateCabinets: true,
        engineeringId: Number(engineeringOptionId),
      });
      const v = await validate(id, bearer(salesToken));
      expect(v.anomalies.some((a) => a.rule === 'custom_engineering')).toBe(false);
    } finally {
      await restoreRule('custom_engineering');
    }
  });
});

describe('Z4 — custom_engineering (warn → warning)', () => {
  it('a real engineering option surfaces a warning anomaly', async () => {
    await snapshotRule('custom_engineering');
    await prisma.anomalyRule.update({ where: { key: 'custom_engineering' }, data: { enabled: true, severity: 'warn' } });

    const id = await newQuote(bearer(salesToken));
    await addLedScreen(id, bearer(salesToken), {
      ledProductId: Number(cleanProductId),
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      rotateCabinets: true,
      engineeringId: Number(engineeringOptionId),
    });
    const v = await validate(id, bearer(salesToken));
    const finding = v.anomalies.find((a) => a.rule === 'custom_engineering');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toMatch(/1590/); // the $ baseline from paramNum is surfaced

    // The explicit "No Engineering" option does NOT trigger the rule.
    const clean = await newQuote(bearer(salesToken));
    await addLedScreen(clean, bearer(salesToken), {
      ledProductId: Number(cleanProductId),
      desiredWidthMm: 1120,
      desiredHeightMm: 1920,
      rotateCabinets: true,
      engineeringId: Number(noEngineeringOptionId),
    });
    const vClean = await validate(clean, bearer(salesToken));
    expect(vClean.anomalies.some((a) => a.rule === 'custom_engineering')).toBe(false);
  });
});

describe('Z4 — air_freight_short_lead (block → error) gates finalisation', () => {
  it('an air-freight screen under the lead-time threshold blocks non-approvers; a director overrides', async () => {
    // The seeded manufacturer lead times (45–60d) + buffer sit around 48–63d. Set the threshold high
    // enough (in weeks) that any air-freight screen is "short lead" → the rule fires deterministically.
    await prisma.anomalyRule.update({
      where: { key: 'air_freight_short_lead' },
      data: { enabled: true, severity: 'block', paramNum: 20 }, // 20 weeks = 140 days > any seed lead
    });
    // Isolate the VALIDATION gate: drop the margin thresholds well below any real margin so the margin
    // guardrail never fires first (which would 403 before the validation 409). Restored below.
    const minSnap = await prisma.setting.findUniqueOrThrow({ where: { key: 'min_gross_margin' } });
    const walkSnap = await prisma.setting.findUniqueOrThrow({ where: { key: 'walk_away_margin' } });
    await prisma.setting.update({ where: { key: 'min_gross_margin' }, data: { value: 0 } });
    await prisma.setting.update({ where: { key: 'walk_away_margin' }, data: { value: 0 } });

    // An air-freight screen (owned by `token`'s user, so ownership scoping lets them act on it).
    const airQuote = async (token: string): Promise<string> => {
      const qid = await newQuote(bearer(token));
      await addLedScreen(qid, bearer(token), {
        ledProductId: Number(leadProductId),
        desiredWidthMm: 1120,
        desiredHeightMm: 1920,
        rotateCabinets: true,
        freightOptionId: Number(airFreightOptionId),
      });
      return qid;
    };

    // Sales-owned quote: the anomaly fires as an error → canFinalise:false, and sales (non-approver)
    // is blocked with a 409 conflict (matching the existing validation-guardrail shape).
    const salesQuote = await airQuote(salesToken);
    const v = await validate(salesQuote, bearer(salesToken));
    const finding = v.anomalies.find((a) => a.rule === 'air_freight_short_lead');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
    expect(v.canFinalise).toBe(false);
    expect(v.counts.error).toBeGreaterThanOrEqual(1);

    const blocked = await approve(salesQuote, bearer(salesToken));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/validation error/);

    // Director-owned quote: a director (approver) can override — audited via `validation_guardrail`.
    const dirQuote = await airQuote(directorToken);
    const ok = await approve(dirQuote, bearer(directorToken));
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(ok.json().status).toBe('approved');

    const audit = await app.inject({ method: 'GET', url: `/quotes/${dirQuote}/audit`, headers: bearer(adminToken) });
    const hasOverride = (audit.json() as Array<{ fieldName: string | null }>).some(
      (a) => a.fieldName === 'validation_guardrail',
    );
    expect(hasOverride).toBe(true);

    // Restore margin thresholds.
    await prisma.setting.update({ where: { key: 'min_gross_margin' }, data: { value: minSnap.value } });
    await prisma.setting.update({ where: { key: 'walk_away_margin' }, data: { value: walkSnap.value } });
  });
});

describe('Z4 — discount_over_cap_aplus (warn → warning)', () => {
  it('an A+ client with >12% discount surfaces a warning anomaly', async () => {
    await prisma.anomalyRule.update({
      where: { key: 'discount_over_cap_aplus' },
      data: { enabled: true, severity: 'warn', paramNum: 12 },
    });

    // A 15% quote discount on an A+ client (admin creates so the >12% cap guardrail allows it, with a note).
    const id = await newQuote(bearer(adminToken), {
      clientId: Number(aplusClientId),
      discountPct: 0.15,
      discountNote: 'Strategic A+ account — approved',
    });
    const v = await validate(id, bearer(adminToken));
    const finding = v.anomalies.find((a) => a.rule === 'discount_over_cap_aplus');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toMatch(/A\+/);

    // A non-A+ (no client) quote at the same discount does NOT trigger the rule.
    const plain = await newQuote(bearer(adminToken), {
      discountPct: 0.15,
      discountNote: 'note',
    });
    const vPlain = await validate(plain, bearer(adminToken));
    expect(vPlain.anomalies.some((a) => a.rule === 'discount_over_cap_aplus')).toBe(false);
  });
});
