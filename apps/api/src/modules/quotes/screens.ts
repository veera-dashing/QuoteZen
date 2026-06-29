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
import { notFound } from '../../errors.js';
import { recordAudit } from '../../services/audit.js';
import { loadPricingConfig } from '../../lib/pricing-config.js';
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
      where: { minCabinetWMm: { not: null }, minCabinetHMm: { not: null }, pixelPitchH: { not: null } },
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
  const config = await loadPricingConfig();
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
    const freightCostAud = freightOpt?.rate && freightKg ? freightKg * Number(freightOpt.rate) : 0;
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
  const totalSellQty = round(totals.totalSell.times(qty));

  const screen = await prisma.$transaction(async (tx) => {
    const created = await tx.quoteLedScreen.create({
      data: {
        quoteId,
        screenName: input.screenName ?? null,
        ledProductId: input.ledProductId ? BigInt(input.ledProductId) : null,
        qty,
        desiredWidthMm: input.desiredWidthMm ?? null,
        desiredHeightMm: input.desiredHeightMm ?? null,
        rotateCabinets: input.rotateCabinets,
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
        priceTotal: totalSellQty.toString(),
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

/** Add an LCD screen as a set of qty-priced line items (display + brackets + install). */
export const addLcdScreen = async (userId: bigint, quoteId: bigint, input: LcdScreenInput) => {
  await getQuote(quoteId);
  const totalSell = input.items.reduce((acc, i) => acc + Number(i.unitSell ?? 0) * Number(i.qty ?? 1), 0);

  return prisma.$transaction(async (tx) => {
    const screen = await tx.quoteLcdScreen.create({
      data: {
        quoteId,
        screenName: input.screenName ?? null,
        displayId: input.displayId ? BigInt(input.displayId) : null,
        installMethodId: input.installMethodId ? BigInt(input.installMethodId) : null,
        serviceHoursId: input.serviceHoursId ? BigInt(input.serviceHoursId) : null,
        warrantyId: input.warrantyId ? BigInt(input.warrantyId) : null,
        priceTotal: round(totalSell).toString(),
        items: {
          create: input.items.map((i) => ({
            displayId: i.displayId ? BigInt(i.displayId) : null,
            itemType: i.itemType,
            description: i.description ?? null,
            qty: i.qty ?? 1,
            unitCost: i.unitCost ?? null,
            unitSell: i.unitSell ?? null,
          })),
        },
      },
      include: { items: true },
    });
    await recordAudit(tx, { quoteId, userId, action: 'create', entityTable: 'quote_lcd_screens', entityId: screen.id });
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
