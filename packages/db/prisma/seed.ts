/**
 * Seed the reference / catalog tables from the original "Quote Base V1.3" workbook.
 *
 * Idempotent: tables with a natural unique key are upserted; the rest are guarded by a row count so
 * re-running does not duplicate. The constants here mirror the `Reference Data` tab exactly (markups,
 * margins, rates, licence tiers, screen ratios, locations, option lists). Bulk product catalogs
 * (led_products ~230, display_catalog ~543) are imported separately — see `prisma/import-catalogs.ts`.
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Reference Data: currencies + budget rates (F2:F9) ────────────────────────
const CURRENCIES: Array<{ code: string; name: string; rate: number; live: number }> = [
  { code: 'AUD', name: 'Australian Dollar', rate: 1, live: 1 },
  { code: 'USD', name: 'US Dollar', rate: 0.6845, live: 0.683865 },
  { code: 'EUR', name: 'Euro', rate: 0.6006, live: 0.60022 },
  { code: 'NZD', name: 'NZ Dollar', rate: 1.21, live: 1.21567 },
  { code: 'SGD', name: 'Singapore Dollar', rate: 0.9, live: 0.88666 },
  { code: 'ZAR', name: 'South African Rand', rate: 11.3449, live: 11.3457 },
  { code: 'GBP', name: 'British Pound', rate: 0.5175, live: 0.51692 },
  { code: 'MYR', name: 'Malaysian Ringgit', rate: 2.8501, live: 2.795606 },
];

// ─── Reference Data: markups / margins / multipliers ──────────────────────────
const SETTINGS: Array<{ key: string; label: string; value?: number; valueText?: string; unit: string }> = [
  { key: 'assembly_labour', label: 'Assembly Labour', value: 45, unit: '$/hr' },
  { key: 'philips_markup', label: 'Philips Markup', value: 1.4, unit: 'x' },
  { key: 'lcd_margin', label: 'LCD Margin', value: 0.3, unit: 'fraction' },
  { key: 'led_margin', label: 'LED Margin', value: 0.33, unit: 'fraction' },
  { key: 'other_equipment_markup', label: 'Other Equipment Mark Up', value: 1.6, unit: 'x' },
  { key: 'metalwork_markup', label: 'Metalwork Markup', value: 1.5, unit: 'x' },
  { key: 'service_markup', label: 'Service Mark Up', value: 1.65, unit: 'x' },
  { key: 'led_markup', label: 'LED Markup', value: 1.5, unit: 'x' },
  { key: 'controller_markup', label: 'Controller Markup', value: 1.5, unit: 'x' },
  { key: 'international_shipping_markup', label: 'International Shipping Markup', value: 1.5, unit: 'x' },
  { key: 'time_estimate_multiplier', label: 'Time Estimate Multiplier', value: 1.3, unit: 'x' },
  { key: 'material_estimate_multiplier', label: 'Material Estimate Multiplier', value: 1.0, unit: 'x' },
  // Add-on + governance settings (Phase 1 deterministic platform).
  { key: 'spares_pct', label: 'Spares %', value: 0.1, unit: 'fraction' },
  { key: 'packaging_pct', label: 'Packaging %', value: 0, unit: 'fraction' },
  { key: 'receiver_card_cost', label: 'Receiver Card Cost (per cabinet)', value: 0, unit: '$' },
  { key: 'margin_floor', label: 'Margin Floor', value: 0.2, unit: 'fraction' },
  // LCD-1 out-of-hours uplift is a LABOUR-COST calc (workbook F31 = SUM(K28:K29) × the uplift rate):
  // install hours = install-line cost ÷ install hourly cost ($95/hr); site-attendance is excluded —
  // it divides by /135 and is not part of SUM(K28:K29). When Service Hours ≠ "Business Hours" those
  // hours are charged at the "Out of Hours uplift" rate (LCDRef r471: $50 cost / $80 sell per hour).
  { key: 'install_hourly_cost', label: 'Install Labour Cost (per hour)', value: 95, unit: '$' },
  { key: 'out_of_hours_rate_cost', label: 'Out-of-Hours Uplift Cost (per hour)', value: 50, unit: '$' },
  { key: 'out_of_hours_rate_sell', label: 'Out-of-Hours Uplift Sell (per hour)', value: 80, unit: '$' },
  // U0 — client discount system default (fraction 0..1); new clients inherit this when none is set.
  { key: 'default_client_discount_pct', label: 'Default Client Discount %', value: 0, unit: 'fraction' },
  // Quote-level discount guardrail (A+): hard CAP (fraction 0..1) on the quote discount override —
  // non-admins are blocked above it; an admin may exceed it (audited). Above the NOTE THRESHOLD a
  // manager justification note is required (any writer). Both are admin-editable.
  { key: 'discount_cap_pct', label: 'Quote Discount Cap %', value: 0.12, unit: 'fraction' },
  { key: 'discount_note_threshold_pct', label: 'Quote Discount Note Threshold %', value: 0.05, unit: 'fraction' },
  // LED ONLY — size-tolerance bands (% CSV): how far the whole-cabinet LED build may differ from the
  // required opening (LED is built up from available cabinet sizes, so an exact match isn't always
  // possible). Not brand-related; not used for LCD (fixed-size displays).
  { key: 'size_tolerance_bands', label: 'LED Size Tolerance Bands', valueText: '5,10,25', unit: '%' },
  // W0 — brightness (nits) at/above which an LED product with no explicit `environment` is treated as
  // outdoor by the config engine (the brightness fallback). Not used when a product sets `environment`.
  { key: 'outdoor_brightness_nits', label: 'Outdoor Brightness Threshold', value: 4000, unit: 'nits' },
  // X2 — the standard warranty baseline (years) already baked into a display's catalog cost. Extended
  // warranty is charged only for years beyond this baseline (extraYears × WarrantyOption.perYearCost).
  // Upserted in the SETTINGS loop below, so a re-seed ensures this key on the live DB (idempotent).
  { key: 'standard_warranty_years', label: 'Standard Warranty Baseline (years)', value: 3, unit: 'yr' },
];

// ─── U0: hardware manufacturers (normalised from led_products.vendor) ─────────
// priority orders manufacturers for future sourcing logic (lower = preferred); leadTimeDays is a
// placeholder until real supplier lead times are loaded. Names MUST match the distinct LedProduct
// `vendor` strings so the backfill below can link led_products.manufacturer_id by name.
const MANUFACTURERS: Array<{ name: string; priority: number; leadTimeDays: number }> = [
  { name: 'LEDFul', priority: 1, leadTimeDays: 45 },
  { name: 'ZonePro', priority: 2, leadTimeDays: 60 },
  { name: 'Muxwave', priority: 3, leadTimeDays: 60 },
];

const SEAFREIGHT: Array<{ label: string; value: number; currency?: string }> = [
  { label: 'Seafreight Origin Charges', value: 660, currency: 'USD' },
  { label: 'Seafreight Transit Charges / CBM', value: 90, currency: 'USD' },
  { label: 'Seafreight Destination Charges', value: 1200, currency: 'AUD' },
  { label: 'Seafreight Multiple', value: 1.3 },
  { label: '20ft Container Rate', value: 8000, currency: 'USD' },
  { label: '40ft Container Rate', value: 12000, currency: 'USD' },
];

const FREIGHT_OPTIONS: Array<{ name: string; rate: number | null }> = [
  { name: 'Freight (Standard Air)', rate: 13 },
  { name: 'Freight (Express Air)', rate: 30 },
  { name: 'Freight (NZ Standard Air)', rate: 18 },
  { name: 'Freight (NZ Express Air)', rate: 30 },
  { name: 'Freight (Sea FCL)', rate: 5 },
  { name: 'Freight (Sea LCL)', rate: null },
  { name: 'No Freight', rate: 0 },
];

// ─── Reference Data: locations (A40:F70) ──────────────────────────────────────
const LOCATIONS: Array<[string, number, number, number, number, number]> = [
  ['Canberra, ACT', 0.1, 50, 0, 0, 25],
  ['Melbourne, VIC', 0.1, 50, 0, 0, 0],
  ['Sydney, NSW', 0.1, 50, 200, 100, 0],
  ['Brisbane, QLD', 0.15, 100, 300, 150, 37],
  ['Gold Coast, QLD', 0.15, 100, 300, 150, 37],
  ['Darwin, NT', 0.4, 200, 600, 200, 30],
  ['Adelaide, SA', 0.1, 50, 200, 100, 0],
  ['Perth, WA', 0.2, 150, 400, 200, 25],
  ['Hobart, TAS', 0.15, 150, 400, 200, 25],
  ['Auckland, NZ', 0.1, 50, 0, 0, 0],
  ['Wellington, NZ', 0.15, 100, 150, 100, 0],
  ['Singapore, SG', 0.15, 100, 150, 100, 0],
  ['Ex Factory', 0, 0, 0, 0, 0],
];

const GOB_OPTIONS: Array<[string, number]> = [
  ['No GOB', 0],
  ['LEDful GOB', 95],
  ['LEDful LOB', 49],
  ['ZonePro GOB', 80],
  ['GOB Included in Base Price', 0],
];

// LED peripherals (controller input/output cards, multifunction card, sensors, converters).
const LED_PERIPHERALS: Array<[string, number]> = [
  ['H-Series Input card (4 x HDMI or 4 x DVI)', 1018],
  ['H-Series Input card (1 x DP 1.2 (8k x 1k))', 1455],
  ['H-Series Output card (16xRJ45)', 2039],
  ['H-Series Output card (2xRJ45 + 1 HDMI Preview)', 1516],
  ['MFN300 Multifunction Card', 151],
  ['Light Sensor (NS060-30A - 30m cable)', 200.23],
  ['Nova CVT310 Multimode Fibre Converters (Need Pair)', 198],
];

// Frames: [name, frame cost, backcover cost, frame install hours].
const FRAMES: Array<[string, number, number, number]> = [
  ['No Frame', 0, 0, 0],
  ['ivisual Portrait Elevated Frame 960 x 1600 (needs backcover)', 750, 218, 4],
  ['ivisual Portrait Elevated Frame 2240 x 1600 (needs backcover)', 1040, 367, 4],
  ['ivisual Landscape Elevated Frame 1920 x 1120mm (Needs backcover)', 820, 218, 4],
  ['Fletchers Bundoor Frame (1120 x 1920, needs backcover)', 488, 218, 2],
  ['Single Pole Floor to ceiling (Gazman Essendon)', 900, 218, 2],
  ['Wall Frame with Trim 1920x 960 (Johnny Bigg)', 585, 0, 2],
  ['ivisual Low Frame 960 x 1920 (needs backcover)', 480, 218, 2],
  ['ivisual Low Frame 1600 x 1600 (needs backcover)', 750, 367, 4],
  ['ivisual Low Frame 1920 x 2880 (needs backcover)', 775, 516, 6],
  ['ivisual Low Frame 2560 x 2400 (needs backcover)', 950, 549, 6],
  ['Plinth 640 x 1120 with trim (e.g. Goodman)', 730, 0, 4],
  ['Plinth 1440 x 2560 with trim (needs backcover e.g. ASICS Harbourtown)', 1560, 309, 4],
  ['Plinth 1440 x 2560 with trim (needs ply, back cover) e.g. Valley Girl', 1180, 309, 4],
  ['Stand near ground 1120x1920 with trim (e.g Bonds Birkenhead)', 770, 218, 4],
  ['Stand 1500 x 2000 with trim (Needs ply and Back cover) e.g. AXL', 850, 309, 4],
  ['Stand 1600 x 2400 with trim (Needs ply and Back cover) e.g. Sea Folly', 1180, 367, 6],
  ['Stand 1120 x 1920 with basecladding, trim and back cover e.g. Strand', 1290, 0, 4],
  ['Stand 1120 x 1600 with basecladding, trim and back cover (Peter Alexander)', 1350, 0, 4],
  ['Stand 1000 x 3000 with side and base trim, needs back cover (rear service)', 1200, 380, 4],
  ['Stand 2000 x 3500 with trim and back cover e.g. ASICS Chatswood', 3500, 0, 8],
  ['Portable 640 x 1920', 1140, 0, 0],
  ['Portable 1280 x 1920', 1450, 0, 0],
  ['Transparent (3000x3000) - Adidas Werribee', 780, 0, 6],
  ['Outdoor - APCO 4 x 1m', 1280, 0, 8],
  ['Outdoor - Share Media 9 x 3m', 9500, 0, 16],
  ['Outdoor - Mainfreight 12 x 4m', 17750, 0, 16],
  ['Outdoor - Lifestyle Communities (2560 x 1440)', 2600, 0, 4],
];

const TRIM_OPTIONS: Array<[string, number, number]> = [
  ['No Trim', 0, 0],
  ['Trim (Sides Only)', 0, 60],
  ['Trim (All Edges)', 60, 60],
  ['Trim (Sides and Bottom)', 30, 60],
  ['Trim (Included in LED supply)', 0.001, 0],
];

const HANGING_BARS: Array<[string, number]> = [
  ['No Hanging Bar', 0],
  ['Hanging Rail per metre width (WALL $95/m)', 95],
  ['Hanging Rail per metre width (BM $70/m)', 70],
  ['Hanging Rail per metre width (HI $60/m)', 60],
];

// ─── Reference Data: screen ratios (A231:C251) ────────────────────────────────
const SCREEN_RATIOS: Array<[number, number, string]> = [
  [3.78, 10.0, '4:1'],
  [3.28, 3.77, '32:9'],
  [2.84, 3.27, '3:1'],
  [2.51, 2.83, '8:3'],
  [2.17, 2.5, '21:9'],
  [1.89, 2.16, '2:1'],
  [1.69, 1.88, '16:9'],
  [1.56, 1.68, '0.67'],
  [1.42, 1.55, '3:2'],
  [1.3, 1.41, '4:3'],
  [1.13, 1.29, '5:4'],
  [0.91, 1.12, '1:1'],
  [0.78, 0.9, '4:5'],
  [0.71, 0.77, '3:4'],
  [0.65, 0.7, '2:3'],
  [0.6, 0.64, '10:16'],
  [0.54, 0.59, '9:16'],
  [0.43, 0.53, '1:2'],
  [0.36, 0.42, '3:8'],
  [0.3, 0.35, '1:3'],
  [0.0, 0.29, '1:4'],
];

// [name, years, perYearCost]. X2: perYearCost is the cost per EXTRA year beyond the standard baseline
// (`standard_warranty_years`, 3). $150/yr is a PLACEHOLDER commercial rate — admins adjust it in the
// warranty-options CRUD. Standard = 0 (the 3-year cover is baked into the display's catalog cost).
const WARRANTIES: Array<[string, number, number]> = [
  ['Standard (3 year)', 3, 0],
  ['Extended (5 year)', 5, 150],
];

const SERVICE_HOURS = ['Business Hours', 'Out of Hours (Before Midnight on a weekday)', 'Out of Hours'];

const ENGINEERING: Array<[string, number]> = [
  ['No Engineering', 0],
  ['Engineering only (Certificate of Design)', 1590],
  ['Engineering and install certification (SDIC)', 2190],
  ['Engineering (CoD Same design, new site)', 1120],
  ['Engineering and install certificate (SDIC Same design, new site)', 1770],
];

const ACCESS_EQUIPMENT: Array<[string, number]> = [
  ['No Access Equipment', 0],
  ['Scissor (Indoor Day)', 600],
  ['Scissor (Outdoor Day)', 700],
  ['Crane Hire (Day)', 2200],
  ['Semi Hire (Day)', 1000],
];

// [name, defaultHours]. X2: defaultHours is PLACEHOLDER install labour (drives the auto install-labour
// line on an LCD screen: defaultHours × the method's hourlyRateCost, or the install_hourly_cost setting
// $95 when null). hourly_rate_cost is left null here → uses the $95 setting. Admins tune both in the CRUD.
// NOTE: EXISTING RDS install-method rows keep default_hours=0 (migration default) until an admin edits
// them, so no existing quote reprices — only FRESH seeds get these placeholders.
const INSTALL_METHODS: Array<[string, number]> = [
  ['Wall Mount', 4],
  ['Ceiling Mount', 4],
  ['Freestanding', 4],
];

const MEDIAPLAYERS: Array<[string, string, number]> = [
  ['SeenCMP Mediaplayer', 'F106D Celeron N5100, 4/128G, WLAN, Windows IoT', 472.8853178],
  ['SeenCMP Mediaplayer (Wide Temperature)', 'AE613 i3-1315U, 2*4G DDR4, 128G SSD', 829.3498904],
  ['SeenCMP Mediaplayer (Mini)', 'M3QD Intel N5105, 8/128G, WLAN, Windows IoT', 278.4514244],
  ['iVisual Mediaplayer', 'Licence $45ex/month, sell at $60ex/month', 690],
  ['Excludes Mediaplayer', '', 0],
];

const CONTROLLERS: Array<[string, string, number, number, number, number]> = [
  ['Sending Box - MCTRL300', 'Standard', 2, 1300000, 3840, 247.73],
  ['Sending Box - MCTRL700', 'Standard', 6, 2600000, 3840, 455.9],
  ['Video Processor and Sender - VX400Pro', 'With Scalar or Switch (VX)', 4, 2600000, 3840, 1518.0],
  ['Sending Card - MSD300', 'Card Only (MSD300)', 1, 650000, 3840, 157.0],
];

// ─── Licence & Support tiers ──────────────────────────────────────────────────
const LICENCE_COMPONENTS: Array<{
  component: string;
  tier: 'low' | 'high';
  screenType: 'LCD' | 'LED';
  value: number;
}> = [
  { component: 'Licence Per Screen', tier: 'low', screenType: 'LCD', value: 125 },
  { component: 'Licence Per Screen', tier: 'low', screenType: 'LED', value: 125 },
  { component: 'Licence Per Screen', tier: 'high', screenType: 'LCD', value: 95 },
  { component: 'Licence Per Screen', tier: 'high', screenType: 'LED', value: 95 },
  { component: 'Interactive Licence Per Screen Uplift', tier: 'low', screenType: 'LCD', value: 100 },
  { component: 'Interactive Licence Per Screen Uplift', tier: 'low', screenType: 'LED', value: 100 },
  { component: 'Interactive Licence Per Screen Uplift', tier: 'high', screenType: 'LCD', value: 100 },
  { component: 'Interactive Licence Per Screen Uplift', tier: 'high', screenType: 'LED', value: 100 },
  { component: 'Site Fee', tier: 'low', screenType: 'LCD', value: 270 },
  { component: 'Site Fee', tier: 'low', screenType: 'LED', value: 270 },
  { component: 'Site Fee', tier: 'high', screenType: 'LCD', value: 165 },
  { component: 'Site Fee', tier: 'high', screenType: 'LED', value: 165 },
];

const CLIENTS: Array<[string, string]> = [
  ['2XU', 'No specific product but low margin - always competitive'],
  ['ASICS', 'Typically P1.8 GOB for larger screens; standard engineered frames in-window'],
  ['Baby Bunting', 'Include trim on all standard screens, P1.5'],
  ['Cotton On', 'Use BM rather than BM-PRO where applicable, 30% margin'],
  ['Peter Alexander', 'All at P1.8; 3:4 ratio; black trim for counter screens; Biamp audio'],
  ['Lovisa', 'Standard screens and price, buy at special LEDFul price'],
  ['iVisual', 'No mediaplayers, default margin 30%, IF2.5-Hi or TGC2.8 standard'],
];

async function main(): Promise<void> {
  console.warn('Seeding reference data…');

  // Roles + demo users
  const roleNames = ['admin', 'sales', 'viewer'];
  for (const name of roleNames) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'admin' } });
  const salesRole = await prisma.role.findUniqueOrThrow({ where: { name: 'sales' } });
  const viewerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'viewer' } });
  const passwordHash = await bcrypt.hash('demo', 10);
  const demoUsers: Array<[string, string, bigint]> = [
    ['admin@quotezen.local', 'Demo Admin', adminRole.id],
    ['sales@quotezen.local', 'Demo Sales', salesRole.id],
    ['viewer@quotezen.local', 'Demo Viewer', viewerRole.id],
  ];
  for (const [email, name, roleId] of demoUsers) {
    await prisma.user.upsert({
      where: { email },
      update: { roleId },
      create: { email, name, passwordHash, roleId },
    });
  }

  // Currencies + exchange rates
  for (const c of CURRENCIES) {
    const currency = await prisma.currency.upsert({
      where: { code: c.code },
      update: { name: c.name },
      create: { code: c.code, name: c.name },
    });
    await prisma.exchangeRate.upsert({
      where: { currencyId: currency.id },
      update: { budgetRate: c.rate, liveRate: c.live },
      create: {
        currencyId: currency.id,
        pairLabel: `AUD/${c.code}`,
        budgetRate: c.rate,
        liveRate: c.live,
      },
    });
  }
  const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });
  const aud = await prisma.currency.findUniqueOrThrow({ where: { code: 'AUD' } });

  // Settings — numeric settings carry `value`; text-only settings (e.g. size_tolerance_bands) use valueText.
  for (const s of SETTINGS) {
    await prisma.setting.upsert({
      where: { key: s.key },
      update: { label: s.label, value: s.value ?? null, valueText: s.valueText ?? null, unit: s.unit },
      create: { key: s.key, label: s.label, value: s.value ?? null, valueText: s.valueText ?? null, unit: s.unit },
    });
  }

  // Count-guarded bulk reference tables (idempotent on re-run).
  await seedIfEmpty('seafreightRate', () =>
    prisma.seafreightRate.createMany({
      data: SEAFREIGHT.map((s) => ({
        label: s.label,
        value: s.value,
        currencyId: s.currency === 'USD' ? usd.id : s.currency === 'AUD' ? aud.id : null,
      })),
    }),
  );
  await seedIfEmpty('freightOption', () =>
    prisma.freightOption.createMany({ data: FREIGHT_OPTIONS }),
  );
  await seedIfEmpty('location', () =>
    prisma.location.createMany({
      data: LOCATIONS.map(([name, m, min, frame, trim, uplift]) => ({
        name,
        freightMultiplier: m,
        freightMin: min,
        frameFreight: frame,
        trimFreight: trim,
        hourlyUplift: uplift,
      })),
    }),
  );
  await seedIfEmpty('gobOption', () =>
    prisma.gobOption.createMany({ data: GOB_OPTIONS.map(([name, price]) => ({ name, price })) }),
  );
  await seedIfEmpty('ledPeripheral', () =>
    prisma.ledPeripheral.createMany({ data: LED_PERIPHERALS.map(([name, price]) => ({ name, price })) }),
  );
  await seedIfEmpty('frame', () =>
    prisma.frame.createMany({
      data: FRAMES.map(([name, price, backcoverCost, installHours]) => ({ name, price, backcoverCost, installHours })),
    }),
  );
  await seedIfEmpty('trimOption', () =>
    prisma.trimOption.createMany({
      data: TRIM_OPTIONS.map(([name, w, h]) => ({ name, widthMultiplier: w, heightMultiplier: h })),
    }),
  );
  await seedIfEmpty('hangingBarOption', () =>
    prisma.hangingBarOption.createMany({
      data: HANGING_BARS.map(([name, w]) => ({ name, widthMultiplier: w })),
    }),
  );
  await seedIfEmpty('screenRatio', () =>
    prisma.screenRatio.createMany({
      data: SCREEN_RATIOS.map(([min, max, label]) => ({
        minValue: min,
        maxValue: max,
        ratioLabel: label,
      })),
    }),
  );
  await seedIfEmpty('warrantyOption', () =>
    prisma.warrantyOption.createMany({
      data: WARRANTIES.map(([name, years, perYearCost]) => ({ name, years, perYearCost })),
    }),
  );
  await seedIfEmpty('serviceHoursOption', () =>
    prisma.serviceHoursOption.createMany({ data: SERVICE_HOURS.map((name) => ({ name })) }),
  );
  await seedIfEmpty('engineeringOption', () =>
    prisma.engineeringOption.createMany({ data: ENGINEERING.map(([name, price]) => ({ name, price })) }),
  );
  await seedIfEmpty('installMethod', () =>
    prisma.installMethod.createMany({
      data: INSTALL_METHODS.map(([name, defaultHours]) => ({ name, defaultHours })),
    }),
  );
  await seedIfEmpty('accessEquipment', () =>
    prisma.accessEquipment.createMany({
      data: ACCESS_EQUIPMENT.map(([name, dayRate]) => ({ name, dayRate })),
    }),
  );
  await seedIfEmpty('mediaplayer', () =>
    prisma.mediaplayer.createMany({
      data: MEDIAPLAYERS.map(([name, description, cost]) => ({ name, description, cost })),
    }),
  );
  await seedIfEmpty('controller', () =>
    prisma.controller.createMany({
      data: CONTROLLERS.map(([name, type, maxPorts, maxPixels, maxWidth, price]) => ({
        name,
        type,
        maxPorts,
        maxPixels: BigInt(maxPixels),
        maxWidth,
        price,
      })),
    }),
  );
  await seedIfEmpty('licenceComponent', () =>
    prisma.licenceComponent.createMany({ data: LICENCE_COMPONENTS }),
  );
  await seedIfEmpty('client', () =>
    prisma.client.createMany({ data: CLIENTS.map(([name, marginNote]) => ({ name, marginNote })) }),
  );

  // ── U0: manufacturers (upsert by unique name) + backfill led_products.manufacturer_id by vendor ──
  // Idempotent: upserts keep the configured priority/leadTimeDays in sync; the backfill only fills
  // products whose vendor matches a manufacturer name and that aren't already linked.
  for (const m of MANUFACTURERS) {
    await prisma.manufacturer.upsert({
      where: { name: m.name },
      update: { priority: m.priority, leadTimeDays: m.leadTimeDays },
      create: m,
    });
  }
  const allManufacturers = await prisma.manufacturer.findMany();
  let linked = 0;
  for (const m of allManufacturers) {
    const res = await prisma.ledProduct.updateMany({
      where: { vendor: m.name, manufacturerId: null },
      data: { manufacturerId: m.id },
    });
    linked += res.count;
  }
  console.warn(`  manufacturers: ${allManufacturers.length} present; linked ${linked} led_products by vendor`);

  console.warn('Seed complete.');
}

/** Run a createMany only when the table is empty, so the seed is safe to re-run. */
async function seedIfEmpty(
  model: string,
  insert: () => Promise<{ count: number }>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = await (prisma as any)[model].count();
  if (count > 0) {
    console.warn(`  ${model}: already has ${count} rows, skipping`);
    return;
  }
  const { count: inserted } = await insert();
  console.warn(`  ${model}: inserted ${inserted}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
