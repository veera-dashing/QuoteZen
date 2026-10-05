# QuoteZen Shared — `packages/shared`

Shared TypeScript types, Zod schemas, money helpers, and enums. Used by `packages/calc`, `apps/api`, and `apps/web`.

Three modules, all re-exported from the package root (`src/index.ts`): `money.ts`, `enums.ts`, `schemas.ts`.

## Money helpers

**Never do arithmetic on `Decimal` with JS `+` / `*` / `/`.** Use the helpers:

```ts
import { d, sum, mul, div, round, applyMargin, applyMarkup, toNumber } from '@quotezen/shared';
```

> There is **no `@quotezen/shared/money` subpath** — `package.json` exports only `"."`. Import from
> the package root. There is also no `add` helper; use `sum([...])` for a list, or `d(a).plus(b)`.

Full surface of `money.ts`:

| Export | What |
|---|---|
| `Numeric` | `Decimal \| number \| string` — accepted by every helper |
| `d(v)` | construct a `Decimal` |
| `ZERO` | `Decimal(0)` |
| `sum(values)` | sum a list, treating `null`/`undefined` as zero |
| `mul(a, b)` / `div(a, b)` | multiply / divide (`div` **throws** on divide-by-zero rather than returning `Infinity`) |
| `round(v, places = 2)` | round half-up to `places` |
| `applyMargin(cost, margin)` | gross-up: `cost / (1 − margin)`. **Throws** unless margin is in `[0, 1)` |
| `applyMarkup(cost, markup)` | multiply: `cost × markup` |
| `marginOf(cost, sell)` | realised margin fraction |
| `toMoneyString(v)` | 2dp fixed string for transport/JSON and Prisma `NUMERIC` |
| `toNumber(v)` | `Decimal` → `number` at a boundary |

Backed by `decimal.js` for arbitrary-precision arithmetic. Postgres stores `NUMERIC`; Prisma maps to `Decimal`.

Pattern for pricing calculations:
```ts
// BAD
const sell = cost * markup;

// GOOD
const sell = applyMarkup(cost, config.markups.led);
```

Convert to `number` only at the boundary (when passing to a calc function that expects `number`), and back to a 2dp string when persisting.

## Zod schemas

External input validation schemas live here so API and web share the same contract.

Quote header: `createQuoteSchema` / `updateQuoteSchema` / `changeStatusSchema` / `listQuotesQuerySchema`
Screens: `ledScreenSchema`, `updateLedScreenSchema`, `ledComponentSchema`, `ledIntakeSchema`, `lcdScreenSchema`, `lcdItemSchema`, `reorderScreensSchema`, `screenQtySchema`
Commercial: `setOverrideSchema`, `lineDiscountSchema`, `quoteLicenceSchema`, `quoteTermsSchema`, `quoteRisksSchema`
Child line items: `quoteMediaplayerSchema`, `quotePeripheralSchema`, `quoteManufacturedSchema`, `quoteAudioSchema`, `quoteSoftwareSchema`, `quoteMusicSchema`, `quoteHypervsnSchema`
Auth: `loginSchema`, `updateMeSchema`
Primitives: `moneySchema`, `idSchema`, `qtySchema`

Each schema exports its inferred type alongside it (`LedScreenInput`, `CreateQuoteInput`, …).

> `configureSchema` (the `POST /quotes/:id/screens/configure` body) is **not** here — it is a local,
> non-exported schema in [apps/api/src/modules/quotes/routes.ts](../../apps/api/src/modules/quotes/routes.ts).
> It wraps `ledIntakeSchema`, which *is* shared.

Conventions:
- Optional fields: `.optional()` for fields that may be absent; `.nullish()` when the client may explicitly clear a value (e.g. `clientId: z.number().nullish()` so sending `null` clears the FK)
- Money inputs: `moneySchema` accepts a number **or** a numeric string and normalises to a `string`; the API converts to `Decimal` before Prisma

## Enums

Every enum is a `readonly` tuple plus its inferred union type (`(typeof X)[number]`).

```ts
CURRENCY_CODES      = ['AUD','USD','EUR','NZD','SGD','ZAR','GBP','MYR']
QUOTE_STATUSES      = ['draft','in_review','technical_review','commercial_review','approved','issued','won','lost']
REVIEW_STAGES       = ['technical','commercial']
REVIEW_DECISIONS    = ['approved','rejected']
SCREEN_TYPES        = ['LED','LCD']
LICENCE_TIERS       = ['low','high']
LED_COMPONENT_TYPES = ['controller','led_peripheral','mediaplayer','mediaplayer_peripheral']
AUDIT_ACTIONS       = ['create','update','delete','status_change']
USER_ROLES          = ['admin','sales','viewer','director','manager']
DISCOUNT_SCOPES     = ['one_off','recurring']
DISCOUNT_MODES      = ['stack','item_only']
RISK_CATEGORIES     = ['technical','commercial','delivery']
RISK_SEVERITIES     = ['low','medium','high']
THEMES              = ['light','dark','system']   // user theme preference
ORIENTATIONS        = ['Landscape','Portrait']    // NOTE: capitalised (LED-1 E10)
ENVIRONMENTS        = ['indoor','outdoor']        // NOTE: no 'both'
```

Two that bite:
- **`ORIENTATIONS` is capitalised** (`'Landscape'`, not `'landscape'`) — it mirrors the workbook cell values.
- **`ENVIRONMENTS` has no `'both'`.** A product with no explicit environment falls back to a brightness heuristic at config time (`effectiveEnvironment` in `packages/calc`), which always resolves to `'indoor' | 'outdoor'`. (The unrelated `'both'` in `tree-evaluator.ts` is a *rule branch*, not an environment.)

## `PricingConfig`

**Not defined here.** `PricingConfig` and `WORKBOOK_DEFAULTS` live in
[packages/calc/src/constants.ts](../calc/src/constants.ts) — see [packages/calc/CLAUDE.md](../calc/CLAUDE.md).
`apps/api` builds one per request from the live `settings` + `exchange_rates` tables in
[apps/api/src/lib/pricing-config.ts](../../apps/api/src/lib/pricing-config.ts).

`packages/shared` contributes only `CurrencyCode`, which keys the config's `rates` map.

## Dependency rule

`packages/shared` has no dependencies on other workspace packages (runtime deps: `decimal.js`, `zod`). It can be imported by `calc`, `api`, and `web`.
