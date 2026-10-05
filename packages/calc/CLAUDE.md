# QuoteZen Calc — `packages/calc`

Pure pricing engine. **No DB, no IO, no side-effects.** Every function is deterministic given its inputs. This makes it trivially testable and safe to run in the browser for live preview.

## Constraint

`packages/calc` must never import from `packages/db` or any I/O library. Its only runtime deps are `@quotezen/shared` and `decimal.js`. If you need a DB value (e.g. a setting), pass it in as a parameter.

## What is NOT here

The workbook logic that needs DB access lives in `apps/api` — don't go looking for it in calc:

| Symbol | Actually lives in |
|---|---|
| `computeLedScreenPricing` / `computeLcdScreenPricing` | [apps/api/src/modules/quotes/screens.ts](../../apps/api/src/modules/quotes/screens.ts) |
| `configureForQuote`, `optionsForQuote`, `lcdOptionsForQuote` | same file (needs tolerance bands, lead-time buffer, catalogue queries) |
| `ledScreenDiscountedSell` / `lcdScreenDiscountedSell` | [apps/api/src/modules/quotes/service.ts](../../apps/api/src/modules/quotes/service.ts) (private helpers) |
| `buildBom`, `buildSolutionSummary`, `buildPmHandoff` | [apps/api/src/modules/quotes/outputs.ts](../../apps/api/src/modules/quotes/outputs.ts) |
| `evaluateAnomalies`, `evaluateEngineAlerts` | `apps/api` (historical queries + settings) |
| out-of-hours rates (`out_of_hours_rate_cost` / `_sell`) | `settings` table, read in `screens.ts` — **not** a calc constant |

Calc provides the pure kernels (`configureScreen`, `ledSupply`, `ledInstall`, …); the API wrapper adds DB context.

## `PricingConfig` (defined here, in `constants.ts`)

The central config struct passed to the pricing functions. **It is defined in this package**, not in `packages/shared`. `apps/api` builds one per request from the live `settings` + `exchange_rates` tables in [apps/api/src/lib/pricing-config.ts](../../apps/api/src/lib/pricing-config.ts), falling back per-key to `WORKBOOK_DEFAULTS`.

```ts
interface PricingConfig {
  markups: {
    philips: number;               // RefData F11 — × multiplier
    lcdMargin: number;             // F12 — fraction
    ledMargin: number;             // F13 — fraction
    otherEquipment: number;        // F14 — ×
    metalwork: number;             // F15 — ×
    service: number;               // F16 — ×
    led: number;                   // F17 — × (applied to LED supply lines)
    controller: number;            // F18 — ×
    internationalShipping: number; // F19 — ×
  };
  freight: {
    assemblyLabour: number;        // F10 — $/hr
    installLabour?: number;        // on-site install $/hr (default 95)
    standardOverheadAud?: number;  // standard overhead allowance (default 475)
    seaOriginUsd: number;          // F20
    seaTransitPerCbmUsd: number;   // F21
    seaDestinationAud: number;     // F22
    seaMultiple: number;           // F23
  };
  addOns: { sparesPct; packagingPct; receiverCardCostAud };
  rates: Record<CurrencyCode, number>;  // budget rates: 1 AUD = rate units of X
}
```

There is **no `marginFloor`** on `PricingConfig` — the margin bands are DB settings read by `getMarginFloor` / `getMinGrossMargin` / `getWalkAwayMargin` in `apps/api`.

## Known constants (`constants.ts`)

Sourced from the `2026-XXX Quote Base V1.3` workbook Reference Data sheet. Never change these without tracing back to the workbook.

```ts
WORKBOOK_DEFAULTS.markups = {
  philips: 1.4,  lcdMargin: 0.3,  ledMargin: 0.33,  otherEquipment: 1.6,
  metalwork: 1.5, service: 1.65,  led: 1.5,  controller: 1.5, internationalShipping: 1.5,
}
WORKBOOK_DEFAULTS.freight = {
  assemblyLabour: 45, installLabour: 95, standardOverheadAud: 475,
  seaOriginUsd: 660, seaTransitPerCbmUsd: 90, seaDestinationAud: 1200, seaMultiple: 1.3,
}
WORKBOOK_DEFAULTS.addOns = { sparesPct: 0.1, packagingPct: 0, receiverCardCostAud: 0 }
WORKBOOK_DEFAULTS.rates  = { AUD: 1, USD: 0.6845, EUR: 0.6006, NZD: 1.21,
                             SGD: 0.9, ZAR: 11.3449, GBP: 0.5175, MYR: 2.8501 }
```

`markups.led` (1.5, a multiplier) and `markups.ledMargin` (0.33, a fraction) are **both** present and both come from the workbook — `led` grosses up LED equipment lines, `ledMargin` is the sell margin applied to totals. They are consistent (`1 − 1/1.5 ≈ 0.333`) but are separate cells (F17 / F13), so don't derive one from the other.

`packagingPct` and `receiverCardCostAud` seed at **0** — a zero produces no line, so those add-ons are strict no-ops until an admin configures a rate.

## Modules

### `constants.ts`
`PricingConfig`, `Markups`, `FreightConfig`, `AddOnConfig`, `WORKBOOK_DEFAULTS`.

### `currency.ts`
`toAud(value, code, config)` / `fromAud(value, code, config)` — budget-rate conversion.

### `geometry.ts`
`snapToCabinets(input)` (opening → whole-cabinet grid, optional rotate), `areaSqm(wMm, hMm)`, `resolutionPx(mm, pitchMm)`, `resolveScreenRatio(widthMm, heightMm, ratios)` (label from the `screen_ratios` lookup).

### `led.ts`
- `ledSupply(input, config)` — area × cost/sqm (USD) → AUD → × `markups.led`. Returns `{ costAud, sellAud }`.
- `ledSpec(input)` — snapped size, cabinet counts, area, resolution, weight, power.
- `sparesCost(supplyCostAud, config, sparesPct?)` — supply × pct, sold at `markups.led`.
- `packagingCost(supplyCostAud, config)` / `receiverCardCost(cabinetCount, config)` — 0 → no line.
- `coatingCost(areaSqm, costPerSqmAud, config)` — area × $/sqm, sold at `markups.led`.
- `highResUplift(supplyCostAud, upliftPct, config)` — supply × pct; no-op at pct 0.
- `freightWeightKg(actualKg, volumetricModifier?)` — MAX(volumetric, actual).
- `seaFreightAud(cbm, config)`.

> Arg order: `coatingCost` and `highResUplift` both take `config` as a **third** argument.

### `lines.ts`
`PricedLine`, `LineBucket`, the `markupLine` / `marginLine` / `fixedLine` builders, `totalsByBucket`, `composeScreenTotals`.

### `config.ts`
- `configureScreen(products, req)` → `ConfigResult` — ranked LED configurations. Comparator order:
  1. `manufacturerPriority` → 2. Selection-Tree `recommendedFamily` → 3. `modelPriority` →
  4. area deviation → 5. `sizeMode` (exact > under > over) → 6. un-rotated first →
  7. preferred ratio → 8. fewer cabinets → 9. coarsest pitch (when `preferCoarsest`) → 10. model name.
- `selectTiers(ranked, lookup)` → tiers keyed **`value` / `recommended` / `premium`** (labelled "Value (Budget / Bronze)", "Recommended (Ideal)", "Premium (Stretch / Gold)"): cheapest cost/sqm, best area fit, finest pitch. Picks distinct products where possible.
- `effectiveEnvironment(env, nits, threshold)` — explicit value, else brightness heuristic. Always resolves to `'indoor' | 'outdoor'`.
- `DEFAULT_OUTDOOR_BRIGHTNESS_NITS` (4000), `GOB_RECOMMENDED_PITCH_MM` (2.5), `PREFERRED_RATIO_LABELS`, `configConfidence`.

### `lcd-tiers.ts`
`selectLcdTiers(candidates, opts)` → the same `value` / `recommended` / `premium` keys (labelled "Good / Better / Best"): lowest sell / closest to `targetSizeIn` then preferred brand then lowest sell / dearest. `LCD_PREFERRED_BRAND`.

### `controller.ts`
`selectController(pixels, controllers)` — pixel-threshold → smallest sufficient controller. Note the arg order: **pixels first**.

### `validation.ts`
- `validateScreen(input)` → `ValidationFinding[]` — LED rules (GOB, outdoor deps, controller↔pixels, cut-cabinet, …).
- `validateLcdScreen(input)` → `ValidationFinding[]` — LCD rules (display required, no mediaplayer/bracket/orientation, depth, Android, bracket sub-range, PC deps).
- `canFinalise(findings)` — false when any finding is an error.

### `install.ts`
- `ledInstall(input, config)` — `sell = (labour + access + freight + overhead) × markups.service + engineering`.
  Labour is `hours × (rate + locationHourlyUplift)`. **`engineeringPrice` is added after the markup** — it
  passes through at cost, so it lands identically in `costAud` and `sellAud`. A
  `freightOverridePerScreenAud` (AA6b), when set, replaces the weight-based freight inside the marked-up base.
- `estimateInstallHours(opts)` — hours from area / cabinet grid / frame / hanging / IT-product flag.
- `ZERO_INSTALL`.

### `freight.ts`
`recommendFreightMode(input)` — available days vs manufacturer lead + buffer + `SEA_TRANSIT_DAYS` (**35**); returns an advisory finding.

### `licence.ts`
`annualLicence({ screenCount, interactiveCount, rates })` — a single `LicenceInput` (the `LicenceRates` are a field on it, not a second argument). Returns `siteFee + perScreen × screens + interactiveUplift × interactive`; 0 screens → 0.

### `descriptions.ts`
`describeLedScreen(parts)`, `describeLcdScreen(parts)` — deterministic per-screen description strings.
`buildLcdOrderList(entries)` — `"2 x Foo, 1 x Bar"` from `{ name, qty }` entries (skips blanks and qty ≤ 0).

### `quote.ts`
`aggregateQuote(lines, resellerMarkup?)` → `QuoteTotals` (equipment / services / recurring / upfront / grandTotal). Mirrors the `Summary` tab. `EMPTY_QUOTE_TOTALS`.

### `tree-evaluator.ts`
LED Selection Tree — 24 questions / 62 rules from `tree.json`. `evaluateSelectionTree(answers, opts?)` → `TreeConstraints` via three forward-chaining passes (special overrides → standard location fallbacks → caveats + GOB). `deriveAutoAnswers(inputs, existing?)` fills redundant answers from geometry. Also exports `TREE_RULES`, `LedIntakeAnswers`, `TreeConstraints`.

The result **guides** `configureScreen` (pre-filter + `recommendedFamily` boost) — it does not replace the geometric cabinet snapping or the tiering.

## LCD headline total (computed in the API — noted here for reference)

The quoted LCD total is **not** the sum of line sells. It is
`ROUND(Σ(cost × qty) / (1 − lcdMargin), nearest $10)` — tab `(LCD 1)` G54. The list-sells are reference figures and deliberately do not reconcile to it.

Correspondingly, the two discounted-sell helpers in `apps/api` differ and are easy to confuse:
- **LED** — `Σ(line.sell × (1 − line.discount))` over the cost breakdown (or a screen-price override).
- **LCD** — `priceTotal × frac`, where `frac = Σ(cost × qty × (1 − disc)) / Σ(cost × qty)`. It starts from the stored fixed-margin total, not from line sells.

## Tests

Tests assert against **known sample outputs** from the workbook:
- LED supply sell: **AUD 5,046.92** (`led.test.ts` reference screen — 2.1504 sqm × 1071 USD/sqm ÷ 0.6845 × 1.5)
- Quote rollup: **AUD 12,380** upfront / grand total (`quote.test.ts`)

When you change a formula, verify the canonical samples are unchanged. Run:
```bash
pnpm --filter @quotezen/calc test
```

**Never add a new constant without tracing it to the workbook.** If the source is unknown, pass it as a parameter with a default and document the uncertainty.
