# QuoteZen Calc — `packages/calc`

Pure pricing engine. **No DB, no IO, no side-effects.** Every function is deterministic given its inputs. This makes it trivially testable and safe to run in the browser for live preview.

## Constraint

`packages/calc` must never import from `packages/db` or any I/O library. If you need a DB value (e.g. a setting), pass it in as a parameter.

## Known constants (from `constants.ts`)

Sourced from the `2026-XXX Quote Base V1.3` workbook Reference Data sheet. Never change these without tracing back to the workbook.

```ts
WORKBOOK_DEFAULTS.markups = {
  led:        1.5,    // LED supply markup multiplier (→ 33.3% margin)
  lcd:        0.30,   // LCD margin (fixed gross-up: sell = cost / (1 − 0.30))
  other:      1.6,    // other equipment markup
  metalwork:  1.5,
  service:    1.65,
  philips:    1.4,
}
WORKBOOK_DEFAULTS.assembly_labour = 45   // AUD/hr
WORKBOOK_DEFAULTS.install_hourly_cost = 95
WORKBOOK_DEFAULTS.out_of_hours_rate_cost = 50
WORKBOOK_DEFAULTS.out_of_hours_rate_sell = 80
```

LED margin = `1 − 1/1.5 = 33.3%`. `ledMargin = 0.33` is a derived constant; `markups.led = 1.5` is the source.

## Key functions

### `led.ts`
- `ledSupplyCost(input, config)` — area × costPerSqm × FX, round to 2dp
- `sparesCost(supply, config)` — `supply × spares_pct`, sell via `config.markups.led` (NOT margin)
- `computeLedScreenPricing(input, config)` — full LED screen cost breakdown, returns `costBreakdown[]` + `priceTotal`
- `coatingCost(areaSqm, ratePerSqm)` — area × $/sqm line
- `highResUplift(supply, pct)` — supply × pct, LED-margin gross-up; no-op when pct = 0

### `lcd.ts`
- `computeLcdScreenPricing(input, config)` — LCD pricing faithful to `(LCD 1)` workbook tab
- `lcdScreenDiscountedSell(screen)` — `Σ(line.sell × (1 − line.discount))` over costBreakdown
- LCD total = `ROUND(Σ(cost×qty) / (1 − lcd_margin), −1)` — NOT the sum of line sells

### `config.ts`
- `configureScreen(request, products)` — ranked LED configurations; sorts by: 1. manufacturerPriority, 2. modelPriority, 3. area-fit, 4. exact>under>over, 5. id tiebreak
- `selectTiers(options)` — Good (value = cheapest cost/sqm) / Better (best-fit) / Best (finest pitch)
- `selectLcdTiers(displays)` — Value (cheapest sell) / Recommended (closest size → preferred brand → lowest sell) / Premium (dearest)

> **Note:** `configureForQuote` is **not** in `packages/calc`. It lives in `apps/api/src/modules/quotes/screens.ts` because it needs DB access for tolerance bands, lead-time buffer, and catalogue queries. The calc layer provides the pure `configureScreen`; the API wrapper adds context from the DB.

### `validation.ts`
- `validateScreen(input)` → `ValidationFinding[]` — LED rules (GOB_REQUIRED, outdoor deps, controller↔pixels, cut-cabinet, etc.)
- `validateLcdScreen(input)` → `ValidationFinding[]` — LCD rules (display required, no mediaplayer/bracket/orientation, depth, Android, bracket sub-range, PC deps)

### `install.ts`
- `ledInstall(input)` — labour hours × (assembly rate + location uplift) + access + freight, × service markup

### `freight.ts`
- `recommendFreightMode(input)` — compares available days vs manufacturer lead + buffer + `SEA_TRANSIT_DAYS` (35); returns advisory finding

### `descriptions.ts`
- `describeLedScreen(input)` — deterministic per-screen description string
- `describeLcdScreen(input)` — model + mediaplayer + components + orientation + warranty

### `outputs.ts`
- `buildBom(quote)`, `buildSolutionSummary(quote)`, `buildPmHandoff(quote)` — proposal outputs

## `PricingConfig`

All pricing functions take a `PricingConfig` (from `packages/shared`). The API resolves it from DB settings before calling calc functions. Structure:

```ts
interface PricingConfig {
  markups: { led, lcd, other, metalwork, service, philips }
  freight: { seaFreightRates: ..., ... }
  addOns: { sparesPct, packagingPct, receiverCardCost }
  rates: { audUsd, assemblyLabour, installHourlyCost, ... }
  marginFloor: number
}
```

## Tests

Tests assert against **known sample outputs** from the workbook Summary sheet:
- LED screen total: **AUD 12,380** (workbook LED-1 sample) / **AUD 5,046.92** (unit-test reference screen)
- LCD screen total: **AUD 10,120** (workbook LCD-1 sample; list sells sum to 10,169 — deliberate discrepancy)

When you change a formula, verify the canonical samples are unchanged. Run:
```bash
pnpm --filter @quotezen/calc test
```

**Never add a new constant without tracing it to the workbook.** If the source is unknown, pass it as a parameter with a default and document the uncertainty.

## Anomaly evaluation

`evaluateAnomalies(quote)` and `evaluateEngineAlerts(quote)` live in `apps/api` (they need DB access for historical queries and settings). Only the pure rule logic that doesn't need DB lives in `calc`.
