# QuoteZen Shared — `packages/shared`

Shared TypeScript types, Zod schemas, money helpers, and enums. Used by `packages/calc`, `apps/api`, and `apps/web`.

## Money helpers

**Never do arithmetic on `Decimal` with JS `+` / `*` / `/`.** Use the helpers:

```ts
import { add, mul, div, round, toNumber } from '@quotezen/shared/money';
```

Backed by `decimal.js` for arbitrary-precision arithmetic. Postgres stores `NUMERIC`; Prisma maps to `Decimal`.

Pattern for pricing calculations:
```ts
// BAD
const sell = cost * markup;

// GOOD
const sell = toNumber(mul(cost, markup));
```

Always convert to `number` at the boundary (when passing to calc functions that expect `number`), and back to `Decimal` when persisting.

## Zod schemas

External input validation schemas live here so API and web share the same contract.

Key schemas:
- `createQuoteSchema` / `updateQuoteSchema` — quote header fields
- `ledScreenSchema` — LED screen add input
- `lcdScreenSchema` — LCD screen add input
- `configureSchema` — screen configuration request (`environment`, `viewingDistanceM`, `allowedRatios`, etc.)

Conventions:
- Optional fields: `.optional()` for fields that may be absent; `.nullish()` when the client may explicitly clear a value (e.g. `clientId: z.number().nullish()` so sending `null` clears the FK)
- Money inputs: `z.number()` (the API receives numbers, converts to Decimal before Prisma)

## Enums

```ts
THEMES = ['light', 'dark', 'system']     // user theme preference
ORIENTATIONS = ['landscape', 'portrait']
ENVIRONMENTS = ['indoor', 'outdoor', 'both']
DISCOUNT_MODES = ['stack', 'item_only']
DISCOUNT_SCOPES = ['one_off', 'recurring']
USER_ROLES = ['admin', 'director', 'manager', 'sales', 'viewer']
```

## `PricingConfig` type

The central config struct passed to all calc functions. API resolves it from DB settings before calling calc:

```ts
interface PricingConfig {
  markups: {
    led: number;        // markup multiplier e.g. 1.5 → 33.3% margin
    lcd: number;        // margin e.g. 0.30
    other: number;
    metalwork: number;
    service: number;
    philips: number;
  };
  freight: { ... };
  addOns: {
    sparesPct: number;
    packagingPct: number;
    receiverCardCost: number;
  };
  rates: {
    audUsd: number;
    assemblyLabour: number;
    installHourlyCost: number;
    outOfHoursRateCost: number;
    outOfHoursRateSell: number;
  };
  marginFloor: number;
}
```

## Dependency rule

`packages/shared` has no dependencies on other workspace packages. It can be imported by `calc`, `api`, and `web`.
