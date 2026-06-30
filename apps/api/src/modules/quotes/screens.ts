import { prisma } from '@quotezen/db';
import {
  composeScreenTotals,
  configureScreen,
  estimateInstallHours,
  fixedLine,
  freightWeightKg,
  ledInstall,
  ledSpec,
  ledSupply,
  markupLine,
  packagingCost,
  receiverCardCost,
  sparesCost,
  type ConfigProduct,
  type PricedLine,
} from '@quotezen/calc';
import { applyMargin, applyMarkup, round } from '@quotezen/shared';
import type { LcdScreenInput, LedScreenInput } from '@quotezen/shared';
import { AppError, notFound } from '../../errors.js';
import { recordAudit } from '../../services/audit.js';
import { loadPricingConfig, loadPricingContext } from '../../lib/pricing-config.js';
import { getQuote } from './service.js';

const dec = (v: { toString(): string } | null | undefined): string => (v ? v.toString() : '0');

/**
 * Price and persist an LED screen on a quote. Geometry + supply cost come from the LED product via
 * packages/calc; components/frame/GOB are looked up from their catalogs and marked up. Services
 * (install/labour) are left at 0 for now — see CLAUDE.md (LED install breakdown is the next calc
 * increment); the value is explicit, not hidden.
 */
/**
 * Run the catalogue-iteration config engine (P1-13) over the live LED catalogue for a desired
 * opening, returning ranked valid configurations the estimator can pick from.
 */
export const configureForQuote = async (
  quoteId: bigint,
  input: { desiredWidthMm: number; desiredHeightMm: number; allowRotation?: boolean },
) => {
  await getQuote(quoteId);
  const [products, ratios] = await Promise.all([
    prisma.ledProduct.findMany({
      // P1-11.4: deprecated LED products are retained for old quotes but excluded from NEW configs.
      where: { deprecated: false, minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null } },
    }),
    prisma.screenRatio.findMany(),
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
    costPerSqmUsd: p.costPerSqmUsd ? Number(p.costPerSqmUsd) : null,
    kgPerSqm: p.kgPerSqm ? Number(p.kgPerSqm) : null,
  }));
  const ratioRows = ratios.map((r) => ({
    minValue: Number(r.minValue),
    maxValue: Number(r.maxValue),
    ratioLabel: r.ratioLabel,
  }));
  return configureScreen(cfgProducts, {
    desiredWidthMm: input.desiredWidthMm,
    desiredHeightMm: input.desiredHeightMm,
    allowRotation: input.allowRotation ?? true,
    ratios: ratioRows,
  });
};

export const addLedScreen = async (userId: bigint, quoteId: bigint, input: LedScreenInput) => {
  const quote = await getQuote(quoteId); // 404s if the quote is missing
  const { config, dbRateCodes } = await loadPricingContext();
  const qty = input.qty ?? 1;

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
        orientation: input.orientation ?? null,
        aspectRatioId: input.aspectRatioId ? BigInt(input.aspectRatioId) : null,
        backCover: input.backCover,
        frameNote: input.frameNote ?? null,
        serviceDescriptionSuffix: input.serviceDescriptionSuffix ?? null,
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
 * - **Out-of-hours uplift (F31):** when Service Hours ≠ "Business Hours", an uplift is added on the
 *   install+labour COST subtotal (config-driven `out_of_hours_uplift_pct`; see seed note) and
 *   grossed up by the same margin.
 *
 * Subtotals are persisted into `priceScreenMediaplayer` (display+mediaplayer sells),
 * `priceBracketShroud` (bracket sells) and `priceServices` (install+labour+location sells).
 */
export const addLcdScreen = async (userId: bigint, quoteId: bigint, input: LcdScreenInput) => {
  await getQuote(quoteId);
  const config = await loadPricingConfig();
  const margin = config.markups.lcdMargin;

  // Out-of-hours? Service Hours is a lookup; the workbook keys off the literal "Business Hours".
  const serviceHours = input.serviceHoursId
    ? await prisma.serviceHoursOption.findUnique({ where: { id: BigInt(input.serviceHoursId) } })
    : null;
  const outOfHours = !!serviceHours && serviceHours.name !== 'Business Hours';
  const upliftSetting = await prisma.setting.findUnique({ where: { key: 'out_of_hours_uplift_pct' } });
  const upliftPct = upliftSetting ? Number(upliftSetting.value) : 0;

  // Resolve every line's authoritative cost; catalog rows win over client-sent prices.
  type Resolved = {
    displayId?: bigint;
    itemType: LcdScreenInput['items'][number]['itemType'];
    description: string | null;
    qty: number;
    unitCost: number;
    unitSell: number; // per-unit
  };
  const resolved: Resolved[] = [];
  for (const i of input.items) {
    const qty = Number(i.qty ?? 1);
    let cost = Number(i.unitCost ?? 0);
    let sell: number | null = i.unitSell !== undefined ? Number(i.unitSell) : null;
    let description = i.description ?? null;
    if (i.displayId) {
      const row = await prisma.displayCatalog.findUnique({ where: { id: BigInt(i.displayId) } });
      if (row) {
        // Authoritative snapshot: cost = total_cost (LCDRef col 8); catalog sell is ignored in favour
        // of the fixed-margin gross-up so the line sell stays consistent with the screen total.
        cost = Number(row.totalCost ?? row.usd ?? 0);
        sell = null; // recompute from margin below
        if (!description) description = row.model;
      }
    }
    // Sell: explicit manual price kept; otherwise gross cost up by the fixed margin (G54 per-line).
    const unitSell = sell !== null ? sell : round(applyMargin(cost, margin)).toNumber();
    resolved.push({
      displayId: i.displayId ? BigInt(i.displayId) : undefined,
      itemType: i.itemType,
      description,
      qty,
      unitCost: round(cost).toNumber(),
      unitSell: round(unitSell).toNumber(),
    });
  }

  // Out-of-hours uplift: a synthetic services line on the install+labour COST subtotal (F31).
  if (outOfHours && upliftPct > 0) {
    const labourCost = resolved
      .filter((r) => r.itemType === 'install' || r.itemType === 'labour')
      .reduce((acc, r) => acc + r.unitCost * r.qty, 0);
    const upliftCost = round(labourCost * upliftPct).toNumber();
    if (upliftCost > 0) {
      resolved.push({
        itemType: 'install',
        description: `Out of Hours uplift (${Math.round(upliftPct * 100)}%)`,
        qty: 1,
        unitCost: upliftCost,
        unitSell: round(applyMargin(upliftCost, margin)).toNumber(),
      });
    }
  }

  // Section subtotals (sell) into the dedicated columns.
  const ext = (r: Resolved) => r.unitSell * r.qty;
  const sumWhere = (pred: (r: Resolved) => boolean) =>
    round(resolved.filter(pred).reduce((a, r) => a + ext(r), 0)).toNumber();
  const priceScreenMediaplayer = sumWhere((r) => r.itemType === 'display' || r.itemType === 'mediaplayer');
  const priceBracketShroud = sumWhere((r) => r.itemType === 'bracket');
  const priceServices = sumWhere(
    (r) => r.itemType === 'install' || r.itemType === 'labour' || r.itemType === 'location_fee',
  );
  // Screen total: workbook G54 — total grossed-up sell rounded to the nearest $10 (ROUND(…, -1)).
  const totalSell = resolved.reduce((a, r) => a + ext(r), 0);
  const priceTotal = round(round(totalSell / 10, 0).toNumber() * 10).toNumber();

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
