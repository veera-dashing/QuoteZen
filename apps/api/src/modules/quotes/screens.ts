import { prisma } from '@quotezen/db';
import {
  composeScreenTotals,
  configConfidence,
  configureScreen,
  DEFAULT_OUTDOOR_BRIGHTNESS_NITS,
  estimateInstallHours,
  fixedLine,
  freightWeightKg,
  ledInstall,
  ledSpec,
  ledSupply,
  markupLine,
  packagingCost,
  receiverCardCost,
  selectTiers,
  sparesCost,
  type ConfigOption,
  type ConfigProduct,
  type PricedLine,
} from '@quotezen/calc';
import { applyMargin, applyMarkup, round } from '@quotezen/shared';
import type { LcdScreenInput, LedScreenInput, UpdateLedScreenInput } from '@quotezen/shared';
import { AppError, notFound } from '../../errors.js';
import { recordAudit } from '../../services/audit.js';
import { loadPricingConfig, loadPricingContext } from '../../lib/pricing-config.js';
import { getQuote, recomputeQuote } from './service.js';

const dec = (v: { toString(): string } | null | undefined): string => (v ? v.toString() : '0');

/**
 * Price and persist an LED screen on a quote. Geometry + supply cost come from the LED product via
 * packages/calc; components/frame/GOB are looked up from their catalogs and marked up. Services
 * (install/labour) are left at 0 for now — see CLAUDE.md (LED install breakdown is the next calc
 * increment); the value is explicit, not hidden.
 */
/** A config option annotated with its size-tolerance band (U2). */
export type ConfigOptionWithBand = ConfigOption & {
  /** Smallest band (%) whose |sizeDeltaPct| ≤ band; 0 for an exact fit. Always within an allowed band. */
  toleranceBand: number;
  /** Always true on returned options — out-of-band candidates are excluded from the result. */
  withinTolerance: boolean;
  /** U8: deterministic 0–100 confidence score for this configuration (fill/ratio/size heuristic). */
  confidence: number;
};

/** Result of {@link configureForQuote} — ranked options carrying manufacturer/lead-time + band data. */
export interface ConfigureResult {
  options: ConfigOptionWithBand[];
  reasons: string[];
  /** The size-tolerance bands (%) applied, ascending — sourced from the `size_tolerance_bands` setting. */
  toleranceBands: number[];
}

/**
 * Size-tolerance bands (U2). Admin-editable via the `size_tolerance_bands` setting (stored as a CSV in
 * `settings.value_text`, e.g. "5,10,25"). An option is "in band" if its absolute size deviation vs the
 * opening (|sizeDeltaPct|) is within one of the bands; its `toleranceBand` is the SMALLEST such band.
 * Options whose deviation exceeds the LARGEST band are excluded (the count is noted in `reasons`).
 * Exact / on-band fits are always kept (band 0 / the matching band).
 */
const DEFAULT_TOLERANCE_BANDS = [5, 10, 25];

/** Read a numeric setting by key (fallback when unset). Mirrors the local reads used elsewhere. */
const settingNum = async (key: string, fallback: number): Promise<number> => {
  const s = await prisma.setting.findUnique({ where: { key } });
  return s?.value != null ? Number(s.value) : fallback;
};

/**
 * Z3 — Lead-time buffer (days, default 3): added to every configured option's manufacturer lead time
 * so the QUOTED lead time already includes Seen's build/handling buffer. Read from the live
 * `lead_time_buffer_days` setting (the calc engine stays pure — the buffer is applied in this API
 * layer where the settings are read). When an option has no manufacturer lead time (`null`), it is
 * left null (we can't buffer an unknown base) — consistent across configure + options.
 */
const loadLeadTimeBuffer = async (): Promise<number> => settingNum('lead_time_buffer_days', 3);

/** Add the lead-time buffer to an option's manufacturer lead time (null stays null). */
const applyLeadTimeBuffer = <T extends { leadTimeDays: number | null }>(opt: T, buffer: number): T =>
  opt.leadTimeDays != null ? { ...opt, leadTimeDays: opt.leadTimeDays + buffer } : opt;

/** Read + parse the `size_tolerance_bands` setting (CSV → sorted ascending positive numbers). */
const loadToleranceBands = async (): Promise<number[]> => {
  const s = await prisma.setting.findUnique({ where: { key: 'size_tolerance_bands' } });
  const parsed = (s?.valueText ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const bands = parsed.length > 0 ? parsed : DEFAULT_TOLERANCE_BANDS;
  return [...new Set(bands)].sort((a, b) => a - b);
};

/**
 * Read the `outdoor_brightness_nits` setting (W0) — the brightness at/above which an LED product with
 * no explicit `environment` is treated as outdoor by the config engine. Falls back to the calc default.
 */
const loadOutdoorBrightnessNits = async (): Promise<number> => {
  const s = await prisma.setting.findUnique({ where: { key: 'outdoor_brightness_nits' } });
  const n = s?.value != null ? Number(s.value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OUTDOOR_BRIGHTNESS_NITS;
};

/** The smallest band whose value ≥ |deviation%|, or null when the deviation exceeds the largest band. */
const bandFor = (sizeDeltaPct: number, bands: readonly number[]): number | null => {
  const abs = Math.abs(sizeDeltaPct);
  if (abs === 0) return 0;
  for (const b of bands) if (abs <= b) return b;
  return null;
};

/**
 * Run the catalogue-iteration config engine (P1-13) over the live LED catalogue for a desired
 * opening, returning ranked valid configurations the estimator can pick from.
 *
 * U2: options are ordered by **manufacturer priority first** (best-fit within each manufacturer), and
 * each carries its manufacturer name + lead time. Options whose size deviation exceeds the largest
 * admin-configured tolerance band are excluded ("show as options only within the allowed bands").
 */
/** Inputs to the config engine over a quote's opening (W0 adds optional environment + viewing distance). */
export interface ConfigureInput {
  desiredWidthMm: number;
  desiredHeightMm: number;
  allowRotation?: boolean;
  /** W0: restrict to indoor/outdoor-suitable products (by product env or brightness fallback). */
  environment?: 'indoor' | 'outdoor';
  /** W0: approximate viewing distance (m); excludes products coarser than ≈1mm-per-metre. */
  viewingDistanceM?: number;
}

export const configureForQuote = async (
  quoteId: bigint,
  input: ConfigureInput,
): Promise<ConfigureResult> => {
  const quote = await getQuote(quoteId);
  // AA2 — per-customer allowed aspect ratios (CSV on the client); empty → no ratio restriction.
  const allowedRatios = (quote.client?.allowedRatios ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const [products, ratios, toleranceBands, outdoorThreshold, leadTimeBuffer] = await Promise.all([
    prisma.ledProduct.findMany({
      // P1-11.4: deprecated LED products are retained for old quotes but excluded from NEW configs.
      where: { deprecated: false, minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null } },
      include: { manufacturer: true },
    }),
    prisma.screenRatio.findMany(),
    loadToleranceBands(),
    loadOutdoorBrightnessNits(),
    loadLeadTimeBuffer(),
  ]);
  const cfgProducts: ConfigProduct[] = products.map((p) => ({
    id: p.id.toString(),
    model: p.model,
    vendor: p.vendor,
    minCabinetWMm: p.minCabinetWMm ?? 0,
    minCabinetHMm: p.minCabinetHMm ?? 0,
    pixelPitchHmm: Number(p.pixelPitchH ?? 0),
    pixelPitchVmm: Number(p.pixelPitchV ?? p.pixelPitchH ?? 0),
    category: p.serviceCategory,
    serviceAccess: p.serviceAccess,
    brightnessNits: p.brightnessNits,
    // W0: indoor/outdoor suitability (null → the engine falls back to the brightness heuristic).
    environment: p.environment === 'indoor' || p.environment === 'outdoor' ? p.environment : null,
    costPerSqmUsd: p.costPerSqmUsd ? Number(p.costPerSqmUsd) : null,
    kgPerSqm: p.kgPerSqm ? Number(p.kgPerSqm) : null,
    // U2: manufacturer priority/name/lead-time from the joined relation (high default when unlinked).
    manufacturerPriority: p.manufacturer?.priority ?? null,
    manufacturerName: p.manufacturer?.name ?? null,
    leadTimeDays: p.manufacturer?.leadTimeDays ?? null,
    // Per-model recommendation priority (admin-set) — secondary ranking key within a manufacturer.
    modelPriority: p.priority ?? null,
  }));
  const ratioRows = ratios.map((r) => ({
    minValue: Number(r.minValue),
    maxValue: Number(r.maxValue),
    ratioLabel: r.ratioLabel,
  }));
  const ranked = configureScreen(cfgProducts, {
    desiredWidthMm: input.desiredWidthMm,
    desiredHeightMm: input.desiredHeightMm,
    allowRotation: input.allowRotation ?? true,
    ratios: ratioRows,
    // W0: thread the environment + viewing-distance filters + the outdoor-brightness threshold.
    environment: input.environment,
    viewingDistanceM: input.viewingDistanceM,
    outdoorBrightnessNits: outdoorThreshold,
    // AA2: restrict offered configs to the client's allowed ratios (empty → no restriction).
    allowedRatios,
  });

  // U2: annotate with tolerance band; drop options beyond the largest band (noting how many).
  const within: ConfigOptionWithBand[] = [];
  let excluded = 0;
  for (const o of ranked.options) {
    const band = bandFor(Number(o.sizeDeltaPct), toleranceBands);
    if (band === null) {
      excluded += 1;
      continue;
    }
    // Z3 — the quoted lead time = manufacturer lead time + the admin-set buffer (null stays null).
    const buffered = applyLeadTimeBuffer(o, leadTimeBuffer);
    within.push({ ...buffered, toleranceBand: band, withinTolerance: true, confidence: configConfidence(buffered) });
  }
  const reasons = [...ranked.reasons];
  if (excluded > 0) {
    const max = toleranceBands[toleranceBands.length - 1]!;
    reasons.push(`${excluded} option(s) excluded for exceeding the largest size-tolerance band (±${max}%).`);
  }
  return { options: within, reasons, toleranceBands };
};

/**
 * Good / Better / Best — three priced, tiered options for an opening (T2; Workshop "Capability 6",
 * FR-057 "recommend alternative products", FR-067 "compare alternative configurations").
 *
 * Deterministic & idempotent — no persistence. Pipeline:
 *  1. run the (deterministic) config engine over the live LED catalogue → ranked valid configs;
 *  2. {@link selectTiers} (pure) picks value (cheapest supply) / recommended (best fit) /
 *     premium (finest pitch) over distinct products where possible, each with a static rationale;
 *  3. price each pick at the **supply level** with the live PricingConfig + FX.
 *
 * SCOPE NOTE: the priced figure is the LED **supply** line only (area × cost/sqm × FX × LED markup),
 * matching the workbook's headline material figure for a screen. Components / frame / GOB / install
 * are intentionally NOT included here — they are per-screen selections made when the screen is added,
 * not part of a like-for-like product comparison. The figure lets the estimator compare the three
 * products' build cost/price; the full price is computed when the screen is added via addLedScreen.
 */
export interface TierOption {
  tier: 'value' | 'recommended' | 'premium';
  label: string;
  rationale: string;
  productId: string;
  model: string;
  vendor?: string | null;
  rotated: boolean;
  widthMm: number;
  heightMm: number;
  cabinetsWide: number;
  cabinetsHigh: number;
  cabinetCount: number;
  resolutionWpx: number;
  resolutionHpx: number;
  ratioLabel: string | null;
  fillPercent: string;
  cutCabinetSuggested: boolean;
  /** W0: horizontal pixel pitch (mm) of the picked product. */
  pixelPitchMm: number;
  /** W0: fine-pitch (<2.5mm) → a GOB coating is recommended. Advisory only. */
  gobRecommended: boolean;
  /** U8: deterministic 0–100 confidence score for this configuration. */
  confidence: number;
  // T3: over/under sizing + aspect-ratio guardrail (guidance, carried through from the config engine).
  sizeMode: 'under' | 'exact' | 'over';
  deltaWidthMm: number;
  deltaHeightMm: number;
  sizeDeltaPct: string;
  ratioPreferred: boolean;
  ratioGuidance: string | null;
  // U2: manufacturer ordering + lead time + size-tolerance band (carried through from configureForQuote).
  manufacturerName: string | null;
  leadTimeDays: number | null;
  /** Per-model recommendation priority (admin-set) — carried through for display/transparency. */
  modelPriority: number;
  toleranceBand: number;
  /** Supply cost (AUD) — masked (null) for non-admin callers (BR-081). */
  supplyCostAud: string | null;
  /** Supply sell price (AUD) — always visible. */
  supplySellAud: string;
  /** Margin on the supply figure (0..1) — admin-only (cost-derived). */
  margin: string | null;
}

export const optionsForQuote = async (
  quoteId: bigint,
  input: ConfigureInput,
  showCost: boolean,
): Promise<{ options: TierOption[]; reasons: string[]; distinctProducts: number }> => {
  const ranked = await configureForQuote(quoteId, input);
  if (ranked.options.length === 0) {
    return { options: [], reasons: ranked.reasons, distinctProducts: 0 };
  }

  // Lookups for the pure tier selector (keyed by productId — the config engine stringifies ids).
  const productIds = new Set(ranked.options.map((o) => String(o.productId)));
  const products = await prisma.ledProduct.findMany({
    where: { id: { in: [...productIds].map((id) => BigInt(id)) } },
  });
  const productById = new Map(products.map((p) => [p.id.toString(), p]));
  const costPerSqm = new Map<string, number>();
  const pixelPitchMm = new Map<string, number>();
  const brightnessNits = new Map<string, number>();
  for (const p of products) {
    const id = p.id.toString();
    if (p.costPerSqmUsd != null) costPerSqm.set(id, Number(p.costPerSqmUsd));
    if (p.pixelPitchH != null) pixelPitchMm.set(id, Number(p.pixelPitchH));
    if (p.brightnessNits != null) brightnessNits.set(id, p.brightnessNits);
  }

  const selection = selectTiers(ranked.options, { costPerSqm, pixelPitchMm, brightnessNits });

  // Price each pick at the supply level with the live config (single FX hard-stop check).
  const { config, dbRateCodes } = await loadPricingContext();
  const priceSupply = (o: ConfigOption): { cost: number; sell: number } => {
    const product = productById.get(String(o.productId));
    if (!product?.costPerSqmUsd || !product.pixelPitchH || !product.pixelPitchV) return { cost: 0, sell: 0 };
    if (!dbRateCodes.has('USD')) {
      throw new AppError('bad_request', 'No exchange rate configured for USD — set the USD rate before pricing options');
    }
    const spec = ledSpec({
      desiredWidthMm: input.desiredWidthMm,
      desiredHeightMm: input.desiredHeightMm,
      cabinetWidthMm: product.minCabinetWMm ?? 0,
      cabinetHeightMm: product.minCabinetHMm ?? 0,
      rotate: o.rotated,
      pixelPitchHmm: Number(product.pixelPitchH),
      pixelPitchVmm: Number(product.pixelPitchV),
      kgPerSqm: Number(product.kgPerSqm ?? 0),
    });
    const supply = ledSupply({ areaSqm: spec.areaSqm, costPerSqmUsd: Number(product.costPerSqmUsd) }, config);
    return { cost: supply.costAud.toNumber(), sell: supply.sellAud.toNumber() };
  };

  const options: TierOption[] = selection.picks.map((pick) => {
    const o = pick.option as ConfigOptionWithBand;
    const { cost, sell } = priceSupply(o);
    const margin = sell > 0 ? (sell - cost) / sell : 0;
    return {
      tier: pick.tier,
      label: pick.label,
      rationale: pick.rationale,
      productId: String(o.productId),
      model: o.model,
      vendor: o.vendor,
      rotated: o.rotated,
      widthMm: o.widthMm,
      heightMm: o.heightMm,
      cabinetsWide: o.cabinetsWide,
      cabinetsHigh: o.cabinetsHigh,
      cabinetCount: o.cabinetCount,
      resolutionWpx: o.resolutionWpx,
      resolutionHpx: o.resolutionHpx,
      ratioLabel: o.ratioLabel,
      fillPercent: o.fillPercent.toString(),
      cutCabinetSuggested: o.cutCabinetSuggested,
      pixelPitchMm: o.pixelPitchMm,
      gobRecommended: o.gobRecommended,
      confidence: o.confidence,
      sizeMode: o.sizeMode,
      deltaWidthMm: o.deltaWidthMm,
      deltaHeightMm: o.deltaHeightMm,
      sizeDeltaPct: o.sizeDeltaPct.toString(),
      ratioPreferred: o.ratioPreferred,
      ratioGuidance: o.ratioGuidance,
      manufacturerName: o.manufacturerName,
      leadTimeDays: o.leadTimeDays,
      modelPriority: o.modelPriority,
      toleranceBand: o.toleranceBand,
      supplyCostAud: showCost ? round(cost).toString() : null,
      supplySellAud: round(sell).toString(),
      margin: showCost ? round(margin, 4).toString() : null,
    };
  });

  return { options, reasons: ranked.reasons, distinctProducts: selection.distinctProducts };
};

interface LedScreenPricing {
  spec: ReturnType<typeof ledSpec> | null;
  lines: PricedLine[];
  compRows: Array<{
    componentType: string;
    controllerId?: bigint;
    ledPeripheralId?: bigint;
    mediaplayerId?: bigint;
    peripheralId?: bigint;
    qty: number;
    unitCostSnapshot: string;
    unitSellSnapshot: string;
  }>;
  labourHours: number;
  freightKg: number | null;
  totals: ReturnType<typeof composeScreenTotals>;
  /** Per-unit screen sell (the quote rollup multiplies by screen qty). */
  unitSell: ReturnType<typeof round>;
  product: Awaited<ReturnType<typeof prisma.ledProduct.findUnique>>;
}

/**
 * Price an LED screen from its inputs (U0). Pure of persistence — returns the priced lines, spec,
 * component rows, labour/freight + totals. Shared by {@link addLedScreen} (initial add) and
 * {@link updateLedScreen} (secondary-options edit) so the two can never price differently.
 */
const computeLedScreenPricing = async (
  quote: Awaited<ReturnType<typeof getQuote>>,
  input: LedScreenInput,
): Promise<LedScreenPricing> => {
  const { config, dbRateCodes } = await loadPricingContext();

  const product = input.ledProductId
    ? await prisma.ledProduct.findUnique({ where: { id: BigInt(input.ledProductId) } })
    : null;

  const lines: PricedLine[] = [];
  let spec: ReturnType<typeof ledSpec> | null = null;

  if (
    product &&
    input.desiredWidthMm &&
    input.desiredHeightMm &&
    product.minCabinetWMm &&
    product.minCabinetHMm &&
    product.pixelPitchH &&
    product.pixelPitchV
  ) {
    spec = ledSpec({
      desiredWidthMm: input.desiredWidthMm,
      desiredHeightMm: input.desiredHeightMm,
      cabinetWidthMm: product.minCabinetWMm,
      cabinetHeightMm: product.minCabinetHMm,
      rotate: input.rotateCabinets,
      pixelPitchHmm: Number(product.pixelPitchH),
      pixelPitchVmm: Number(product.pixelPitchV),
      kgPerSqm: Number(product.kgPerSqm ?? 0),
      powerAvgWPerSqm: product.powerAvgW ? Number(product.powerAvgW) : undefined,
      powerMaxWPerSqm: product.powerMaxW ? Number(product.powerMaxW) : undefined,
    });
    if (product.costPerSqmUsd) {
      // FX hard-stop (P1-07.5): the LED supply cost is quoted in USD and converted to AUD. The USD
      // rate must come from the live exchange_rates table — never silently fall back to a stale
      // workbook number. If the DB has no USD rate, stop and name the currency.
      if (!dbRateCodes.has('USD')) {
        throw new AppError('bad_request', 'No exchange rate configured for USD — set the USD rate before pricing this screen');
      }
      const supply = ledSupply({ areaSqm: spec.areaSqm, costPerSqmUsd: Number(product.costPerSqmUsd) }, config);
      lines.push({
        label: `LED supply — ${product.model}`,
        bucket: 'screen_mediaplayer',
        qty: 1,
        costAud: supply.costAud,
        sellAud: supply.sellAud,
      });
      // Spares allowance (10% of supply by default).
      const spares = sparesCost(supply.costAud, config);
      lines.push({
        label: 'Spares',
        bucket: 'screen_mediaplayer',
        qty: 1,
        costAud: spares.costAud,
        sellAud: spares.sellAud,
      });
      // Packaging + receiver cards (config-driven; only added when configured > 0).
      const packaging = packagingCost(supply.costAud, config);
      if (packaging.costAud.greaterThan(0)) {
        lines.push({ label: 'Packaging', bucket: 'screen_mediaplayer', qty: 1, costAud: packaging.costAud, sellAud: packaging.sellAud });
      }
      const receivers = receiverCardCost(spec.cabinetCount, config);
      if (receivers.costAud.greaterThan(0)) {
        lines.push({ label: 'Receiver cards', bucket: 'screen_mediaplayer', qty: 1, costAud: receivers.costAud, sellAud: receivers.sellAud });
      }
    }
  }

  // Components from their catalogs, with per-category markup/margin.
  const compRows: Array<{
    componentType: string;
    controllerId?: bigint;
    ledPeripheralId?: bigint;
    mediaplayerId?: bigint;
    peripheralId?: bigint;
    qty: number;
    unitCostSnapshot: string;
    unitSellSnapshot: string;
  }> = [];

  for (const c of input.components ?? []) {
    let cost = 0;
    let sell = 0;
    let label: string = c.componentType;
    if (c.controllerId) {
      const row = await prisma.controller.findUnique({ where: { id: BigInt(c.controllerId) } });
      cost = Number(row?.price ?? 0);
      sell = applyMarkup(cost, config.markups.controller).toNumber();
      label = `Controller — ${row?.name ?? ''}`;
    } else if (c.ledPeripheralId) {
      const row = await prisma.ledPeripheral.findUnique({ where: { id: BigInt(c.ledPeripheralId) } });
      cost = Number(row?.price ?? 0);
      sell = applyMarkup(cost, config.markups.led).toNumber();
      label = `LED peripheral — ${row?.name ?? ''}`;
    } else if (c.mediaplayerId) {
      const row = await prisma.mediaplayer.findUnique({ where: { id: BigInt(c.mediaplayerId) } });
      cost = Number(row?.cost ?? 0);
      sell = applyMargin(cost, config.markups.ledMargin).toNumber();
      label = `Mediaplayer — ${row?.name ?? ''}`;
    } else if (c.peripheralId) {
      const row = await prisma.peripheral.findUnique({ where: { id: BigInt(c.peripheralId) } });
      cost = Number(row?.cost ?? 0);
      sell = applyMarkup(cost, config.markups.otherEquipment).toNumber();
      label = `Peripheral — ${row?.name ?? ''}`;
    }
    lines.push({ label, bucket: 'screen_mediaplayer', qty: c.qty, costAud: round(cost * c.qty), sellAud: round(sell * c.qty) });
    compRows.push({
      componentType: c.componentType,
      controllerId: c.controllerId ? BigInt(c.controllerId) : undefined,
      ledPeripheralId: c.ledPeripheralId ? BigInt(c.ledPeripheralId) : undefined,
      mediaplayerId: c.mediaplayerId ? BigInt(c.mediaplayerId) : undefined,
      peripheralId: c.peripheralId ? BigInt(c.peripheralId) : undefined,
      qty: c.qty,
      unitCostSnapshot: String(round(cost)),
      unitSellSnapshot: String(round(sell)),
    });
  }

  // Frame + GOB (metalwork markup).
  if (input.frameId) {
    const frame = await prisma.frame.findUnique({ where: { id: BigInt(input.frameId) } });
    if (frame) {
      const cost = Number(frame.price) + Number(frame.backcoverCost);
      lines.push(markupLine(`Frame — ${frame.name}`, 'frame_trim', cost, config.markups.metalwork));
    }
  }
  if (input.gobId && spec) {
    const gob = await prisma.gobOption.findUnique({ where: { id: BigInt(input.gobId) } });
    if (gob && Number(gob.price) > 0) {
      const cost = Number(gob.price) * spec.areaSqm.toNumber();
      lines.push(markupLine(`GOB — ${gob.name}`, 'frame_trim', cost, config.markups.metalwork));
    }
  }

  // Install / labour + freight (services bucket).
  let labourHours = 0;
  let freightKg: number | null = null;
  if (spec) {
    const area = spec.areaSqm.toNumber();
    const [frame, hangingBar, access, engineering, freightOpt] = await Promise.all([
      input.frameId ? prisma.frame.findUnique({ where: { id: BigInt(input.frameId) } }) : null,
      input.hangingBarId ? prisma.hangingBarOption.findUnique({ where: { id: BigInt(input.hangingBarId) } }) : null,
      input.accessEquipmentId ? prisma.accessEquipment.findUnique({ where: { id: BigInt(input.accessEquipmentId) } }) : null,
      input.engineeringId ? prisma.engineeringOption.findUnique({ where: { id: BigInt(input.engineeringId) } }) : null,
      input.freightOptionId ? prisma.freightOption.findUnique({ where: { id: BigInt(input.freightOptionId) } }) : null,
    ]);
    if (product?.kgPerSqm) {
      const vol = Number(product.volumetricModifier ?? 1);
      const actualKg = area * Number(product.kgPerSqm);
      freightKg = round(freightWeightKg(actualKg, vol)).toNumber(); // MAX(volumetric, actual)
    }
    // Freight hard-stop (P1-16.9): if a freight option was explicitly selected it MUST carry a rate —
    // a missing/zero rate is a misconfiguration, not a free shipment. Name the option and stop rather
    // than silently pricing freight at 0.
    if (freightOpt && !(Number(freightOpt.rate) > 0)) {
      throw new AppError('bad_request', `Freight option "${freightOpt.name}" has no rate configured`);
    }
    const freightCostAud = freightOpt && freightKg ? freightKg * Number(freightOpt.rate) : 0;
    labourHours = estimateInstallHours({
      areaSqm: area,
      frameInstallHours: frame ? Number(frame.installHours) : 0,
      hanging: hangingBar ? Number(hangingBar.widthMultiplier) > 0 : false,
    });
    const install = ledInstall(
      {
        labourHours,
        locationHourlyUplift: quote.location ? Number(quote.location.hourlyUplift) : 0,
        accessEquipmentDayRate: access ? Number(access.dayRate) : 0,
        freightCostAud,
        engineeringPrice: engineering ? Number(engineering.price) : 0,
      },
      config,
    );
    lines.push(fixedLine('Install, labour & freight', 'services', install.costAud, install.sellAud));
  }

  const totals = composeScreenTotals(lines);
  // priceTotal is the per-unit screen price; the quote rollup multiplies by qty (P1-14.2).
  const unitSell = round(totals.totalSell);

  return { spec, lines, compRows, labourHours, freightKg, totals, unitSell, product };
};

export const addLedScreen = async (userId: bigint, quoteId: bigint, input: LedScreenInput) => {
  const quote = await getQuote(quoteId); // 404s if the quote is missing
  const qty = input.qty ?? 1;

  const { spec, lines, compRows, labourHours, freightKg, totals, unitSell, product } =
    await computeLedScreenPricing(quote, input);

  const screen = await prisma.$transaction(async (tx) => {
    const maxOrder = await tx.quoteLedScreen.aggregate({
      where: { quoteId },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1;
    const created = await tx.quoteLedScreen.create({
      data: {
        quoteId,
        screenName: input.screenName ?? null,
        ledProductId: input.ledProductId ? BigInt(input.ledProductId) : null,
        qty,
        sortOrder,
        desiredWidthMm: input.desiredWidthMm ?? null,
        desiredHeightMm: input.desiredHeightMm ?? null,
        rotateCabinets: input.rotateCabinets,
        recessDepthMm: input.recessDepthMm ?? null,
        orientation: input.orientation ?? null,
        aspectRatioId: input.aspectRatioId ? BigInt(input.aspectRatioId) : null,
        backCover: input.backCover,
        frameNote: input.frameNote ?? null,
        serviceDescriptionSuffix: input.serviceDescriptionSuffix ?? null,
        contentRatio: input.contentRatio ?? null,
        contentSupplier: input.contentSupplier ?? null,
        flatnessRequired: input.flatnessRequired ?? null,
        gobId: input.gobId ? BigInt(input.gobId) : null,
        frameId: input.frameId ? BigInt(input.frameId) : null,
        trimId: input.trimId ? BigInt(input.trimId) : null,
        hangingBarId: input.hangingBarId ? BigInt(input.hangingBarId) : null,
        engineeringId: input.engineeringId ? BigInt(input.engineeringId) : null,
        installMethodId: input.installMethodId ? BigInt(input.installMethodId) : null,
        freightOptionId: input.freightOptionId ? BigInt(input.freightOptionId) : null,
        warrantyId: input.warrantyId ? BigInt(input.warrantyId) : null,
        serviceHoursId: input.serviceHoursId ? BigInt(input.serviceHoursId) : null,
        accessEquipmentId: input.accessEquipmentId ? BigInt(input.accessEquipmentId) : null,
        marginOverride: input.marginOverride ?? null,
        resolutionWpx: spec?.resolutionWpx ?? null,
        resolutionHpx: spec?.resolutionHpx ?? null,
        totalPixels: spec ? BigInt(spec.totalPixels) : null,
        weightKg: spec ? spec.weightKg.toString() : null,
        powerAvgW: spec?.powerAvgW ? Math.round(spec.powerAvgW.toNumber()) : null,
        powerMaxW: spec?.powerMaxW ? Math.round(spec.powerMaxW.toNumber()) : null,
        cabinetDepthMm: product?.cabinetDepthMm ?? null,
        labourHours: labourHours ? labourHours.toString() : null,
        freightKg: freightKg !== null ? freightKg.toString() : null,
        priceScreenMediaplayer: totals.screenMediaplayerSell.toString(),
        priceFrameTrim: totals.frameTrimSell.toString(),
        priceServices: totals.servicesSell.toString(),
        priceTotal: unitSell.toString(),
        components: {
          create: compRows.map((r) => ({
            componentType: r.componentType as never,
            controllerId: r.controllerId ?? null,
            ledPeripheralId: r.ledPeripheralId ?? null,
            mediaplayerId: r.mediaplayerId ?? null,
            peripheralId: r.peripheralId ?? null,
            qty: r.qty,
            unitCostSnapshot: r.unitCostSnapshot,
            unitSellSnapshot: r.unitSellSnapshot,
          })),
        },
        costBreakdown: {
          create: lines.map((l) => ({
            lineLabel: l.label,
            category: l.bucket,
            cost: l.costAud.toString(),
            sell: l.sellAud.toString(),
          })),
        },
      },
      include: { components: true, costBreakdown: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'create',
      entityTable: 'quote_led_screens',
      entityId: created.id,
      changes: [{ field: 'price_total', oldValue: null, newValue: created.priceTotal }],
    });
    return created;
  });

  return screen;
};

export const deleteLedScreen = async (userId: bigint, quoteId: bigint, screenId: bigint) => {
  const screen = await prisma.quoteLedScreen.findFirst({ where: { id: screenId, quoteId } });
  if (!screen) throw notFound('LED screen', screenId.toString());
  await prisma.$transaction(async (tx) => {
    await tx.quoteLedScreen.delete({ where: { id: screenId } });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'delete',
      entityTable: 'quote_led_screens',
      entityId: screenId,
    });
  });
};

/**
 * Deep-copy an LED screen (all input FKs + computed/snapshot columns) plus its components and
 * cost-breakdown children, placed at the end of the quote's order, named "<name> (copy)" (P1-14.1).
 */
export const duplicateLedScreen = async (userId: bigint, quoteId: bigint, screenId: bigint) => {
  const source = await prisma.quoteLedScreen.findFirst({
    where: { id: screenId, quoteId },
    include: { components: true, costBreakdown: true },
  });
  if (!source) throw notFound('LED screen', screenId.toString());

  const copy = await prisma.$transaction(async (tx) => {
    const maxOrder = await tx.quoteLedScreen.aggregate({ where: { quoteId }, _max: { sortOrder: true } });
    const created = await tx.quoteLedScreen.create({
      data: {
        quoteId,
        seq: source.seq,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
        screenName: `${source.screenName ?? 'LED screen'} (copy)`,
        ledProductId: source.ledProductId,
        qty: source.qty,
        desiredWidthMm: source.desiredWidthMm,
        desiredHeightMm: source.desiredHeightMm,
        rotateCabinets: source.rotateCabinets,
        orientation: source.orientation,
        aspectRatioId: source.aspectRatioId,
        backCover: source.backCover,
        frameNote: source.frameNote,
        serviceDescriptionSuffix: source.serviceDescriptionSuffix,
        contentRatio: source.contentRatio,
        contentSupplier: source.contentSupplier,
        flatnessRequired: source.flatnessRequired,
        gobId: source.gobId,
        frameId: source.frameId,
        trimId: source.trimId,
        hangingBarId: source.hangingBarId,
        engineeringId: source.engineeringId,
        installMethodId: source.installMethodId,
        freightOptionId: source.freightOptionId,
        warrantyId: source.warrantyId,
        serviceHoursId: source.serviceHoursId,
        accessEquipmentId: source.accessEquipmentId,
        marginOverride: source.marginOverride,
        resolutionWpx: source.resolutionWpx,
        resolutionHpx: source.resolutionHpx,
        totalPixels: source.totalPixels,
        weightKg: source.weightKg,
        powerAvgW: source.powerAvgW,
        powerMaxW: source.powerMaxW,
        heatAvgBtu: source.heatAvgBtu,
        heatMaxBtu: source.heatMaxBtu,
        cabinetDepthMm: source.cabinetDepthMm,
        recessSize: source.recessSize,
        recessDepthMm: source.recessDepthMm,
        freightKg: source.freightKg,
        labourHours: source.labourHours,
        spareModulesPct: source.spareModulesPct,
        spareHubCard: source.spareHubCard,
        sparePowerSupply: source.sparePowerSupply,
        powerSupplySpec: source.powerSupplySpec,
        cabinetSizes: source.cabinetSizes,
        protectivePackage: source.protectivePackage,
        gobCoatingNote: source.gobCoatingNote,
        bracketsNote: source.bracketsNote,
        controllerSeenRef: source.controllerSeenRef,
        ledSize: source.ledSize,
        dataSpec: source.dataSpec,
        serviceAccess: source.serviceAccess,
        physicalInstall: source.physicalInstall,
        powerAndData: source.powerAndData,
        estimatedCost: source.estimatedCost,
        actualCost: source.actualCost,
        priceScreenMediaplayer: source.priceScreenMediaplayer,
        priceFrameTrim: source.priceFrameTrim,
        priceServices: source.priceServices,
        priceTotal: source.priceTotal,
        components: {
          create: source.components.map((c) => ({
            componentType: c.componentType,
            controllerId: c.controllerId,
            ledPeripheralId: c.ledPeripheralId,
            mediaplayerId: c.mediaplayerId,
            peripheralId: c.peripheralId,
            qty: c.qty,
            unitCostSnapshot: c.unitCostSnapshot,
            unitSellSnapshot: c.unitSellSnapshot,
          })),
        },
        costBreakdown: {
          create: source.costBreakdown.map((l) => ({
            lineLabel: l.lineLabel,
            category: l.category,
            cost: l.cost,
            sell: l.sell,
          })),
        },
      },
      include: { components: true, costBreakdown: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'create',
      entityTable: 'quote_led_screens',
      entityId: created.id,
      changes: [{ field: 'duplicated_from', oldValue: null, newValue: screenId.toString() }],
    });
    return created;
  });
  return copy;
};

/** Set LED screen order from a full list of ids (index → sortOrder). All ids must belong to the quote. */
export const reorderLedScreens = async (userId: bigint, quoteId: bigint, orderedIds: number[]) => {
  const owned = await prisma.quoteLedScreen.findMany({ where: { quoteId }, select: { id: true } });
  const ownedIds = new Set(owned.map((s) => s.id.toString()));
  const ids = orderedIds.map((n) => BigInt(n));
  if (ids.length !== ownedIds.size || ids.some((id) => !ownedIds.has(id.toString()))) {
    throw new AppError('bad_request', 'orderedIds must list exactly the screens belonging to this quote');
  }
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.quoteLedScreen.update({ where: { id: ids[i]! }, data: { sortOrder: i } });
    }
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'update',
      entityTable: 'quote_led_screens',
      entityId: quoteId,
      changes: [{ field: 'sort_order', oldValue: null, newValue: orderedIds.join(',') }],
    });
  });
};

/** Update a single LED screen's quantity (positive int enforced by the schema), then recompute. */
export const setLedScreenQty = async (userId: bigint, quoteId: bigint, screenId: bigint, qty: number) => {
  const screen = await prisma.quoteLedScreen.findFirst({ where: { id: screenId, quoteId } });
  if (!screen) throw notFound('LED screen', screenId.toString());
  await prisma.$transaction(async (tx) => {
    await tx.quoteLedScreen.update({ where: { id: screenId }, data: { qty } });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'update',
      entityTable: 'quote_led_screens',
      entityId: screenId,
      changes: [{ field: 'qty', oldValue: String(screen.qty), newValue: String(qty) }],
    });
  });
};

/**
 * Patch an existing LED screen's secondary options/services (U0) — frame, trim, GOB, hanging bar,
 * engineering, install method, freight, warranty, service hours, access equipment, back cover, notes
 * and margin override. The product + geometry + components are NOT touched (they are finalised at
 * add time). RE-PRICES the screen via the shared {@link computeLedScreenPricing} (so the price stays
 * correct), replaces the cost breakdown, recomputes the quote, and audits the change.
 *
 * This powers the LED "two-form" flow: finalise the screen (product + geometry), then edit
 * trim/frame/etc. on the finalised screen.
 */
export const updateLedScreen = async (
  userId: bigint,
  quoteId: bigint,
  screenId: bigint,
  input: UpdateLedScreenInput,
) => {
  const quote = await getQuote(quoteId); // 404s if the quote is missing
  const screen = await prisma.quoteLedScreen.findFirst({
    where: { id: screenId, quoteId },
    include: { components: true },
  });
  if (!screen) throw notFound('LED screen', screenId.toString());

  // Reconstruct the screen's existing product/geometry/component inputs, then overlay the patch.
  // `null` in the patch clears a FK/note; `undefined` (omitted) keeps the current value.
  const opt = <T,>(patch: T | null | undefined, current: T | null): T | undefined => {
    if (patch === undefined) return current ?? undefined; // unchanged
    return patch ?? undefined; // null → cleared
  };
  const num = (v: bigint | null): number | undefined => (v != null ? Number(v) : undefined);

  const pricingInput: LedScreenInput = {
    screenName: screen.screenName ?? undefined,
    ledProductId: num(screen.ledProductId),
    qty: screen.qty,
    desiredWidthMm: screen.desiredWidthMm ?? undefined,
    desiredHeightMm: screen.desiredHeightMm ?? undefined,
    rotateCabinets: screen.rotateCabinets,
    orientation: (screen.orientation as LedScreenInput['orientation']) ?? undefined,
    aspectRatioId: num(screen.aspectRatioId),
    backCover: input.backCover ?? screen.backCover,
    frameNote: opt(input.frameNote, screen.frameNote),
    serviceDescriptionSuffix: opt(input.serviceDescriptionSuffix, screen.serviceDescriptionSuffix),
    gobId: opt(input.gobId, num(screen.gobId) ?? null),
    frameId: opt(input.frameId, num(screen.frameId) ?? null),
    trimId: opt(input.trimId, num(screen.trimId) ?? null),
    hangingBarId: opt(input.hangingBarId, num(screen.hangingBarId) ?? null),
    engineeringId: opt(input.engineeringId, num(screen.engineeringId) ?? null),
    installMethodId: opt(input.installMethodId, num(screen.installMethodId) ?? null),
    freightOptionId: opt(input.freightOptionId, num(screen.freightOptionId) ?? null),
    warrantyId: opt(input.warrantyId, num(screen.warrantyId) ?? null),
    serviceHoursId: opt(input.serviceHoursId, num(screen.serviceHoursId) ?? null),
    accessEquipmentId: opt(input.accessEquipmentId, num(screen.accessEquipmentId) ?? null),
    marginOverride:
      input.marginOverride === undefined
        ? (screen.marginOverride != null ? Number(screen.marginOverride) : undefined)
        : (input.marginOverride ?? undefined),
    components: screen.components.map((c) => ({
      componentType: c.componentType as LedScreenInput['components'][number]['componentType'],
      controllerId: num(c.controllerId),
      ledPeripheralId: num(c.ledPeripheralId),
      mediaplayerId: num(c.mediaplayerId),
      peripheralId: num(c.peripheralId),
      qty: c.qty,
    })),
  };

  const { lines, labourHours, freightKg, totals, unitSell, product } =
    await computeLedScreenPricing(quote, pricingInput);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.quoteLedScreen.update({
      where: { id: screenId },
      data: {
        backCover: pricingInput.backCover,
        frameNote: pricingInput.frameNote ?? null,
        serviceDescriptionSuffix: pricingInput.serviceDescriptionSuffix ?? null,
        gobId: pricingInput.gobId ? BigInt(pricingInput.gobId) : null,
        frameId: pricingInput.frameId ? BigInt(pricingInput.frameId) : null,
        trimId: pricingInput.trimId ? BigInt(pricingInput.trimId) : null,
        hangingBarId: pricingInput.hangingBarId ? BigInt(pricingInput.hangingBarId) : null,
        engineeringId: pricingInput.engineeringId ? BigInt(pricingInput.engineeringId) : null,
        installMethodId: pricingInput.installMethodId ? BigInt(pricingInput.installMethodId) : null,
        freightOptionId: pricingInput.freightOptionId ? BigInt(pricingInput.freightOptionId) : null,
        warrantyId: pricingInput.warrantyId ? BigInt(pricingInput.warrantyId) : null,
        serviceHoursId: pricingInput.serviceHoursId ? BigInt(pricingInput.serviceHoursId) : null,
        accessEquipmentId: pricingInput.accessEquipmentId ? BigInt(pricingInput.accessEquipmentId) : null,
        marginOverride: pricingInput.marginOverride ?? null,
        cabinetDepthMm: product?.cabinetDepthMm ?? null,
        labourHours: labourHours ? labourHours.toString() : null,
        freightKg: freightKg !== null ? freightKg.toString() : null,
        priceScreenMediaplayer: totals.screenMediaplayerSell.toString(),
        priceFrameTrim: totals.frameTrimSell.toString(),
        priceServices: totals.servicesSell.toString(),
        priceTotal: unitSell.toString(),
        // Re-derive the cost breakdown (the priced lines drive the itemised view + margin).
        costBreakdown: {
          deleteMany: {},
          create: lines.map((l) => ({
            lineLabel: l.label,
            category: l.bucket,
            cost: l.costAud.toString(),
            sell: l.sellAud.toString(),
          })),
        },
      },
      include: { components: true, costBreakdown: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'update',
      entityTable: 'quote_led_screens',
      entityId: screenId,
      changes: [{ field: 'price_total', oldValue: dec(screen.priceTotal), newValue: row.priceTotal }],
    });
    return row;
  });

  // Re-roll the quote totals so the new screen price flows into the grand total.
  await recomputeQuote(userId, quoteId);
  return updated;
};

/**
 * Full re-edit of an existing LED screen (V3) — the whole add form, pre-filled. UNLIKE the
 * options-only PATCH ({@link updateLedScreen}), this replaces EVERY input: product, geometry,
 * orientation/aspect, back cover / notes, all option FKs, AND the component list. It re-prices via
 * the SAME {@link computeLedScreenPricing} path as {@link addLedScreen} (never a forked formula),
 * replaces the components and the cost breakdown, recomputes the quote and audits.
 *
 * Preserved: the row's `id`, `sortOrder`, and `qty` (qty stays the current value unless the input
 * supplies one). Note: replacing the cost breakdown clears any V2 per-line discounts on the old
 * lines — expected on a full re-edit (fresh lines have no discount to inherit).
 */
export const updateLedScreenFull = async (
  userId: bigint,
  quoteId: bigint,
  screenId: bigint,
  input: LedScreenInput,
) => {
  const quote = await getQuote(quoteId); // 404s if the quote is missing
  const screen = await prisma.quoteLedScreen.findFirst({ where: { id: screenId, quoteId } });
  if (!screen) throw notFound('LED screen', screenId.toString());

  // qty is PRESERVED across a full re-edit — it has its own dedicated endpoint (PATCH …/qty), and the
  // add schema defaults qty to 1, so we can't distinguish "omitted" from "1". Keep the current qty so
  // a re-edit never silently resets it (spec: id/sortOrder/qty preserved). Pricing is per-unit anyway.
  const qty = screen.qty;
  const pricingInput: LedScreenInput = { ...input, qty };

  const { spec, lines, compRows, labourHours, freightKg, totals, unitSell, product } =
    await computeLedScreenPricing(quote, pricingInput);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.quoteLedScreen.update({
      where: { id: screenId },
      data: {
        // sortOrder + id are untouched (not in `data`); qty preserved (or overridden by input).
        screenName: input.screenName ?? null,
        ledProductId: input.ledProductId ? BigInt(input.ledProductId) : null,
        qty,
        desiredWidthMm: input.desiredWidthMm ?? null,
        desiredHeightMm: input.desiredHeightMm ?? null,
        rotateCabinets: input.rotateCabinets,
        recessDepthMm: input.recessDepthMm ?? null,
        orientation: input.orientation ?? null,
        aspectRatioId: input.aspectRatioId ? BigInt(input.aspectRatioId) : null,
        backCover: input.backCover,
        frameNote: input.frameNote ?? null,
        serviceDescriptionSuffix: input.serviceDescriptionSuffix ?? null,
        contentRatio: input.contentRatio ?? null,
        contentSupplier: input.contentSupplier ?? null,
        flatnessRequired: input.flatnessRequired ?? null,
        gobId: input.gobId ? BigInt(input.gobId) : null,
        frameId: input.frameId ? BigInt(input.frameId) : null,
        trimId: input.trimId ? BigInt(input.trimId) : null,
        hangingBarId: input.hangingBarId ? BigInt(input.hangingBarId) : null,
        engineeringId: input.engineeringId ? BigInt(input.engineeringId) : null,
        installMethodId: input.installMethodId ? BigInt(input.installMethodId) : null,
        freightOptionId: input.freightOptionId ? BigInt(input.freightOptionId) : null,
        warrantyId: input.warrantyId ? BigInt(input.warrantyId) : null,
        serviceHoursId: input.serviceHoursId ? BigInt(input.serviceHoursId) : null,
        accessEquipmentId: input.accessEquipmentId ? BigInt(input.accessEquipmentId) : null,
        marginOverride: input.marginOverride ?? null,
        resolutionWpx: spec?.resolutionWpx ?? null,
        resolutionHpx: spec?.resolutionHpx ?? null,
        totalPixels: spec ? BigInt(spec.totalPixels) : null,
        weightKg: spec ? spec.weightKg.toString() : null,
        powerAvgW: spec?.powerAvgW ? Math.round(spec.powerAvgW.toNumber()) : null,
        powerMaxW: spec?.powerMaxW ? Math.round(spec.powerMaxW.toNumber()) : null,
        cabinetDepthMm: product?.cabinetDepthMm ?? null,
        labourHours: labourHours ? labourHours.toString() : null,
        freightKg: freightKg !== null ? freightKg.toString() : null,
        priceScreenMediaplayer: totals.screenMediaplayerSell.toString(),
        priceFrameTrim: totals.frameTrimSell.toString(),
        priceServices: totals.servicesSell.toString(),
        priceTotal: unitSell.toString(),
        // Replace the component list wholesale (V3 = full re-edit).
        components: {
          deleteMany: {},
          create: compRows.map((r) => ({
            componentType: r.componentType as never,
            controllerId: r.controllerId ?? null,
            ledPeripheralId: r.ledPeripheralId ?? null,
            mediaplayerId: r.mediaplayerId ?? null,
            peripheralId: r.peripheralId ?? null,
            qty: r.qty,
            unitCostSnapshot: r.unitCostSnapshot,
            unitSellSnapshot: r.unitSellSnapshot,
          })),
        },
        // Replace the cost breakdown (clears any old per-line discounts — expected on full re-edit).
        costBreakdown: {
          deleteMany: {},
          create: lines.map((l) => ({
            lineLabel: l.label,
            category: l.bucket,
            cost: l.costAud.toString(),
            sell: l.sellAud.toString(),
          })),
        },
      },
      include: { components: true, costBreakdown: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'update',
      entityTable: 'quote_led_screens',
      entityId: screenId,
      changes: [{ field: 'price_total', oldValue: dec(screen.priceTotal), newValue: row.priceTotal }],
    });
    return row;
  });

  await recomputeQuote(userId, quoteId);
  return updated;
};

/**
 * Resolve every LCD line to its authoritative point-in-time cost/sell and compute the section
 * subtotals + grossed-up screen total — the SINGLE pricing path shared by {@link addLcdScreen} and
 * {@link updateLcdScreen} so create + re-edit price identically (catalog-cost resolution + fixed
 * margin gross-up + out-of-hours labour uplift + subtotals + G54 rounding).
 */
type LcdResolvedLine = {
  displayId?: bigint;
  itemType: LcdScreenInput['items'][number]['itemType'];
  description: string | null;
  qty: number;
  unitCost: number;
  unitSell: number;
};
interface LcdPricing {
  resolved: LcdResolvedLine[];
  priceScreenMediaplayer: number;
  priceBracketShroud: number;
  priceServices: number;
  priceTotal: number;
}

const computeLcdScreenPricing = async (
  input: LcdScreenInput,
  locationHourlyUplift: number,
): Promise<LcdPricing> => {
  const config = await loadPricingConfig();
  const margin = config.markups.lcdMargin;

  // Out-of-hours? Service Hours is a lookup; the workbook keys off the literal "Business Hours".
  const serviceHours = input.serviceHoursId
    ? await prisma.serviceHoursOption.findUnique({ where: { id: BigInt(input.serviceHoursId) } })
    : null;
  const outOfHours = !!serviceHours && serviceHours.name !== 'Business Hours';
  const settingNum = async (key: string, fallback: number): Promise<number> => {
    const s = await prisma.setting.findUnique({ where: { key } });
    return s ? Number(s.value) : fallback;
  };
  const installHourlyCost = await settingNum('install_hourly_cost', 95);
  const oohRateCost = await settingNum('out_of_hours_rate_cost', 50);
  const oohRateSell = await settingNum('out_of_hours_rate_sell', 80);
  const standardWarrantyYears = await settingNum('standard_warranty_years', 3);
  // Manual-row list Sell = Cost × service markup ('Reference Data'!F16 = 1.65). Catalog rows use the
  // LCDRef list Sell (display_catalog.sell) instead — see the per-line resolution below.
  const serviceMarkup = await settingNum('service_markup', 1.65);

  // X2: strip prior server-generated lines BEFORE resolving so create AND re-edit regenerate cleanly
  // (no duplication). Dropped: any warranty line (all warranty lines are auto), the auto install-method
  // labour line ("Installation — …") and the Out-of-Hours uplift line. This also fixes a latent re-edit
  // double-count of the OOH line — it is regenerated below after this strip.
  const items = input.items.filter((i) => {
    if (i.itemType === 'warranty') return false;
    if (i.itemType === 'install') {
      const d = i.description ?? '';
      if (d.startsWith('Installation — ')) return false;
      if (/^Out of Hours uplift/i.test(d)) return false;
      if (d.startsWith('Location travel uplift')) return false;
    }
    return true;
  });

  const resolved: LcdResolvedLine[] = [];
  for (const i of items) {
    const qty = Number(i.qty ?? 1);
    let cost = Number(i.unitCost ?? 0);
    // Faithful to the (LCD 1) tab: the item breakdown shows the LIST Sell per line (col D), NOT a
    // margin gross-up. For a catalog row that is `display_catalog.sell`; for a manual row it is the
    // client-sent price, else Cost × service markup (tab D=C*'Reference Data'!F16, F16=1.65). Note the
    // line sells are REFERENCE — they do NOT sum to the headline total, which is the fixed-margin total
    // computed below (tab G54). See CLAUDE.md.
    let sell: number | null = i.unitSell !== undefined ? Number(i.unitSell) : null;
    let description = i.description ?? null;
    if (i.displayId) {
      const row = await prisma.displayCatalog.findUnique({ where: { id: BigInt(i.displayId) } });
      if (row) {
        cost = Number(row.totalCost ?? row.usd ?? 0);
        // Catalog line: list Sell from LCDRef; fall back to the margin gross-up only if `sell` is null.
        sell = row.sell != null ? Number(row.sell) : null;
        if (!description) description = row.model;
      }
    }
    const unitSell =
      sell !== null
        ? sell
        : i.displayId
          ? round(applyMargin(cost, margin)).toNumber() // catalog w/ no list sell → fixed-margin fallback
          : round(cost * serviceMarkup).toNumber(); // manual row → Cost × service markup (1.65)
    resolved.push({
      displayId: i.displayId ? BigInt(i.displayId) : undefined,
      itemType: i.itemType,
      description,
      qty,
      unitCost: round(cost).toNumber(),
      unitSell: round(unitSell).toNumber(),
    });
  }

  // FEATURE 2 (tab F23 = SUM(F9:F11)): a "Media Player Configuration" install/labour line's qty is
  // auto-set to the number of mediaplayers on the screen (0 if none). Done before totals so cost +
  // priceTotal reflect the corrected qty.
  const mediaplayerCount = resolved
    .filter((r) => r.itemType === 'mediaplayer')
    .reduce((acc, r) => acc + r.qty, 0);
  for (const r of resolved) {
    if (
      (r.itemType === 'install' || r.itemType === 'labour') &&
      /media\s*player configuration/i.test(r.description ?? '')
    ) {
      r.qty = mediaplayerCount;
    }
  }

  // X2: install-method labour line — pushed BEFORE the OOH block so it feeds the uplift hours (install
  // labour incurs the out-of-hours uplift when service hours ≠ Business Hours). rate = the method's own
  // hourly rate, else the install_hourly_cost setting ($95).
  if (input.installMethodId) {
    const method = await prisma.installMethod.findUnique({ where: { id: BigInt(input.installMethodId) } });
    const defaultHours = method ? Number(method.defaultHours) : 0;
    if (method && defaultHours > 0) {
      const rate = method.hourlyRateCost != null ? Number(method.hourlyRateCost) : installHourlyCost;
      const unitCost = round(defaultHours * rate).toNumber();
      resolved.push({
        itemType: 'install',
        description: `Installation — ${method.name} (${defaultHours} hrs @ $${rate}/hr)`,
        qty: 1,
        unitCost,
        unitSell: round(applyMargin(unitCost, margin)).toNumber(),
      });
    }
  }

  // FEATURE 3 (tab row 30): location-driven travel/labour uplift. Total install hours (K40) = Σ over
  // install lines of cost/(site-attendance ? 135 : 95); a site-attendance line is identified by its
  // description. The location's hourly uplift ($/hr, from locations.hourly_uplift) is charged over
  // those hours, marked up by the service markup. This line carries NO install hours of its own, so it
  // must be pushed AFTER the K40 tally and it must never feed the OOH calc (the OOH filter divides by
  // installHourlyCost — including this line would recursively inflate the uplift), hence the guard below.
  {
    const totalInstallHours = resolved
      .filter((r) => r.itemType === 'install')
      .reduce((acc, r) => {
        const isSiteAttendance = /site attendance/i.test(r.description ?? '');
        const perHourCost = isSiteAttendance ? 135 : installHourlyCost;
        return perHourCost > 0 ? acc + (r.unitCost * r.qty) / perHourCost : acc;
      }, 0);
    if (locationHourlyUplift > 0 && totalInstallHours > 0) {
      const unitCost = round(locationHourlyUplift * totalInstallHours).toNumber();
      resolved.push({
        itemType: 'install',
        description: `Location travel uplift (${round(totalInstallHours).toNumber()} hrs @ $${locationHourlyUplift}/hr)`,
        qty: 1,
        unitCost,
        unitSell: round(unitCost * serviceMarkup).toNumber(),
      });
    }
  }

  if (outOfHours && installHourlyCost > 0) {
    const upliftHours = resolved
      .filter(
        (r) =>
          r.itemType === 'install' &&
          !/site attendance/i.test(r.description ?? '') &&
          !(r.description ?? '').startsWith('Location travel uplift'),
      )
      .reduce((acc, r) => acc + (r.unitCost * r.qty) / installHourlyCost, 0);
    if (upliftHours > 0) {
      resolved.push({
        itemType: 'install',
        description: `Out of Hours uplift (${round(upliftHours).toNumber()} hrs @ $${oohRateCost}/hr)`,
        qty: 1,
        unitCost: round(upliftHours * oohRateCost).toNumber(),
        unitSell: round(upliftHours * oohRateSell).toNumber(),
      });
    }
  }

  // X2: extended-warranty line — charged only for years BEYOND the standard baseline (the first N years'
  // warranty is baked into the display catalog cost). Added AFTER the OOH block so it never feeds the
  // uplift-hours calc (warranty is not install labour; the OOH filter is itemType==='install' only).
  if (input.warrantyId) {
    const warranty = await prisma.warrantyOption.findUnique({ where: { id: BigInt(input.warrantyId) } });
    if (warranty) {
      const extraYears = Math.max(0, warranty.years - standardWarrantyYears);
      const perYearCost = Number(warranty.perYearCost);
      if (extraYears > 0 && perYearCost > 0) {
        const unitCost = round(extraYears * perYearCost).toNumber();
        resolved.push({
          itemType: 'warranty',
          description: `Extended warranty (+${extraYears} yr @ $${perYearCost}/yr)`,
          qty: 1,
          unitCost,
          unitSell: round(applyMargin(unitCost, margin)).toNumber(),
        });
      }
    }
  }

  // THE HEADLINE QUOTED TOTAL is NOT the sum of line sells — it is the total COST grossed at the fixed
  // LCD margin and rounded to the nearest $10 (tab G54 = ROUND(H46/(1−I54), −1), I54 = lcd_margin). The
  // line list-sells are reference and generally do NOT equal this total — the tab reconciles via its
  // per-section analysis block (G51/G52/G53), which we mirror below.
  const grossFixed = (cost: number): number =>
    cost > 0 ? round(round(applyMargin(cost, margin).dividedBy(10), 0).toNumber() * 10).toNumber() : 0;
  const costWhere = (pred: (r: LcdResolvedLine) => boolean) =>
    round(resolved.filter(pred).reduce((a, r) => a + r.unitCost * r.qty, 0)).toNumber();
  const hardwareCost = costWhere((r) => r.itemType === 'display' || r.itemType === 'mediaplayer');
  const bracketCost = costWhere((r) => r.itemType === 'bracket');
  const servicesCost = costWhere(
    (r) =>
      r.itemType === 'install' ||
      r.itemType === 'labour' ||
      r.itemType === 'location_fee' ||
      r.itemType === 'warranty',
  );
  const totalCost = round(resolved.reduce((a, r) => a + r.unitCost * r.qty, 0)).toNumber();
  // Section subtotals = per-section fixed-margin values (tab analysis G51/G52/G53). These ≈ sum to
  // priceTotal (rounding aside), matching the tab's analysis block.
  const priceScreenMediaplayer = grossFixed(hardwareCost);
  const priceBracketShroud = grossFixed(bracketCost);
  const priceServices = grossFixed(servicesCost);
  // priceTotal = ROUND(totalCost / (1 − lcdMargin), nearest $10) — the number the customer sees (G54).
  const priceTotal = grossFixed(totalCost);

  return { resolved, priceScreenMediaplayer, priceBracketShroud, priceServices, priceTotal };
};

/**
 * Full re-edit of an existing LCD screen (V3) — replaces the screen's fields (name/orientation/
 * display/install/service-hours/warranty) AND all its line items, re-pricing via the SAME
 * {@link computeLcdScreenPricing} path as {@link addLcdScreen}. Preserves `id`/`sortOrder`.
 * Recomputes the quote + audits.
 */
export const updateLcdScreen = async (
  userId: bigint,
  quoteId: bigint,
  screenId: bigint,
  input: LcdScreenInput,
) => {
  const quote = await getQuote(quoteId);
  const screen = await prisma.quoteLcdScreen.findFirst({ where: { id: screenId, quoteId } });
  if (!screen) throw notFound('LCD screen', screenId.toString());

  const { resolved, priceScreenMediaplayer, priceBracketShroud, priceServices, priceTotal } =
    await computeLcdScreenPricing(input, Number(quote.location?.hourlyUplift ?? 0));

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.quoteLcdScreen.update({
      where: { id: screenId },
      data: {
        // id + sortOrder preserved (not in `data`).
        screenName: input.screenName ?? null,
        orientation: input.orientation ?? null,
        displayId: input.displayId ? BigInt(input.displayId) : null,
        installMethodId: input.installMethodId ? BigInt(input.installMethodId) : null,
        serviceHoursId: input.serviceHoursId ? BigInt(input.serviceHoursId) : null,
        warrantyId: input.warrantyId ? BigInt(input.warrantyId) : null,
        recessDepthMm: input.recessDepthMm ?? null,
        // AA3a — site/requirement fields (descriptive; feed the selection rules, not pricing).
        requiresAndroid: input.requiresAndroid ?? null,
        maxDepthMm: input.maxDepthMm ?? null,
        needsPc: input.needsPc ?? null,
        needsHardDrive: input.needsHardDrive ?? null,
        priceScreenMediaplayer: priceScreenMediaplayer.toString(),
        priceBracketShroud: priceBracketShroud.toString(),
        priceServices: priceServices.toString(),
        priceTotal: priceTotal.toString(),
        items: {
          deleteMany: {},
          create: resolved.map((r) => ({
            displayId: r.displayId ?? null,
            itemType: r.itemType,
            description: r.description,
            qty: r.qty,
            unitCost: r.unitCost.toString(),
            unitSell: r.unitSell.toString(),
          })),
        },
      },
      include: { items: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'update',
      entityTable: 'quote_lcd_screens',
      entityId: screenId,
      changes: [{ field: 'price_total', oldValue: dec(screen.priceTotal), newValue: row.priceTotal?.toString() ?? null }],
    });
    return row;
  });

  await recomputeQuote(userId, quoteId);
  return updated;
};

/**
 * Price and persist an LCD screen as the LCD-1 questionnaire — a set of qty-priced line items
 * across the sheet's sections (Display, Mediaplayer & Peripherals, Bracket & Shroud,
 * Configuration/Installation, Seen Labour, Location Fees). Faithful to the workbook:
 *
 * - **Catalog items** (rows carrying `displayId`) resolve their cost+sell SERVER-SIDE from
 *   `display_catalog` (authoritative point-in-time snapshot), never trusting client-sent prices.
 *   Cost = `total_cost` (LCDRef col 8); manual/fixed rows (no `displayId`) use the client-sent
 *   `unitCost`/`unitSell` (e.g. Parking 50, Travel 75).
 * - **Fixed margin** (Reference Data F12 = `lcd_margin`): the workbook derives the screen total as
 *   `G54 = ROUND(totalCost/(1−margin), -1)`. We push that margin down to each line so the per-item
 *   `unitSell = round(cost/(1−margin))` and `priceTotal = round(Σ extendedSell, -1)` — i.e. the sum
 *   of line sells equals the grossed-up total, so the quote rollup (which sums line sells) and this
 *   total never drift. A manual row that already carries a `unitSell` keeps it (an explicit price);
 *   otherwise sell is computed from cost.
 * - **Out-of-hours uplift (F31) — a labour-cost calc:** when Service Hours ≠ "Business Hours", the
 *   install labour HOURS (install-line cost ÷ `install_hourly_cost`, $95/hr; site-attendance excluded —
 *   the workbook divides it by /135 and leaves it out of SUM(K28:K29)) are charged at the out-of-hours
 *   uplift rate (`out_of_hours_rate_cost` $50/hr cost, `out_of_hours_rate_sell` $80/hr sell — LCDRef r471).
 *
 * Subtotals are persisted into `priceScreenMediaplayer` (display+mediaplayer sells),
 * `priceBracketShroud` (bracket sells) and `priceServices` (install+labour+location sells).
 */
export const addLcdScreen = async (userId: bigint, quoteId: bigint, input: LcdScreenInput) => {
  const quote = await getQuote(quoteId);
  const { resolved, priceScreenMediaplayer, priceBracketShroud, priceServices, priceTotal } =
    await computeLcdScreenPricing(input, Number(quote.location?.hourlyUplift ?? 0));

  return prisma.$transaction(async (tx) => {
    const maxOrder = await tx.quoteLcdScreen.aggregate({ where: { quoteId }, _max: { sortOrder: true } });
    const screen = await tx.quoteLcdScreen.create({
      data: {
        quoteId,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
        screenName: input.screenName ?? null,
        orientation: input.orientation ?? null,
        displayId: input.displayId ? BigInt(input.displayId) : null,
        installMethodId: input.installMethodId ? BigInt(input.installMethodId) : null,
        serviceHoursId: input.serviceHoursId ? BigInt(input.serviceHoursId) : null,
        warrantyId: input.warrantyId ? BigInt(input.warrantyId) : null,
        recessDepthMm: input.recessDepthMm ?? null,
        // AA3a — site/requirement fields (descriptive; feed the selection rules, not pricing).
        requiresAndroid: input.requiresAndroid ?? null,
        maxDepthMm: input.maxDepthMm ?? null,
        needsPc: input.needsPc ?? null,
        needsHardDrive: input.needsHardDrive ?? null,
        priceScreenMediaplayer: priceScreenMediaplayer.toString(),
        priceBracketShroud: priceBracketShroud.toString(),
        priceServices: priceServices.toString(),
        priceTotal: priceTotal.toString(),
        items: {
          create: resolved.map((r) => ({
            displayId: r.displayId ?? null,
            itemType: r.itemType,
            description: r.description,
            qty: r.qty,
            unitCost: r.unitCost.toString(),
            unitSell: r.unitSell.toString(),
          })),
        },
      },
      include: { items: true },
    });
    await recordAudit(tx, {
      quoteId,
      userId,
      action: 'create',
      entityTable: 'quote_lcd_screens',
      entityId: screen.id,
      changes: [{ field: 'price_total', oldValue: null, newValue: screen.priceTotal?.toString() ?? null }],
    });
    return screen;
  });
};

/** Generic licence line. */
export const addLicence = async (
  userId: bigint,
  quoteId: bigint,
  input: { licenceComponentId?: number; screenType: 'LCD' | 'LED'; tier: 'low' | 'high'; qty: number; isInteractive: boolean },
) => {
  await getQuote(quoteId);
  return prisma.$transaction(async (tx) => {
    const licence = await tx.quoteLicence.create({
      data: {
        quoteId,
        licenceComponentId: input.licenceComponentId ? BigInt(input.licenceComponentId) : null,
        screenType: input.screenType,
        tier: input.tier,
        qty: input.qty,
        isInteractive: input.isInteractive,
      },
    });
    await recordAudit(tx, { quoteId, userId, action: 'create', entityTable: 'quote_licences', entityId: licence.id });
    return licence;
  });
};

export { dec };
