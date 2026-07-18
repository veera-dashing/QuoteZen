# QuoteZen API — `apps/api`

Fastify REST API. JWT auth, full quote CRUD, audit logging, recompute via `packages/calc`.

## Layering

```
routes/        HTTP boundary: Zod parse, call service, return JSON
services/      Business logic, audit writes, DB transactions
repositories/  Prisma queries (no business logic)
```

**Never** call Prisma directly from a route. **Never** do business logic in a repository.

## Conventions

- **Validation:** every external input parsed with a Zod schema from `packages/shared`. Reject early (400/422).
- **Errors:** `{ error: { code, message, details? } }` envelope. Use typed error helpers — never bare `throw`.
- **Audit:** all quote mutations write `quote_audit_log` rows **in the same transaction** as the change. Never mutate a quote without an audit row.
- **Money:** Postgres `NUMERIC` / Prisma `Decimal`. Never do arithmetic on `Decimal` with JS `+`/`*` — use `packages/shared` money helpers.
- **No `any`** (lint-enforced). Prefer `unknown` + narrowing.
- **Naming:** DB `snake_case`; TS `camelCase`; types `PascalCase`; files `kebab-case.ts`.
- **Tests:** Vitest integration tests, co-located as `*.test.ts`. Run against the live RDS — no mocks. A change to pricing logic **must** come with a test.

## Auth & RBAC

JWT auth. Roles: `admin`, `sales`, `manager`, `director`, `viewer`.

| Role | Access |
|---|---|
| admin | All quotes, all admin endpoints, cost fields, can override guardrails |
| director | Write + own quotes + `/kb` + `/users/viewers`; can approve below walk-away margin |
| manager | Same as director but cannot approve below walk-away floor |
| sales | Write + own quotes only |
| viewer | Read-only, own assigned quotes only |

`assertOwnership` + scoped list: sales/manager/director see only their own + assigned quotes. Admins see all.

**Quote access:** admin sees all; others see quotes they created **or** are assigned to as a viewer (`quote_viewers` join). Assign via `viewerUserIds` on create/edit.

## Key service patterns

### `changeStatus` guardrail order

In `service.ts`, `changeStatus` checks in this order for finalisation (`approved` / `issued`):
1. Two-stage reviews required (both `technical_review` + `commercial_review` approved for current revision)
2. **Margin guardrail** — `computeMargin` vs `min_gross_margin` / `walk_away_margin`:
   - ≥ `min_gross_margin` (0.28) → OK for anyone
   - `walk_away_margin` (0.22) ≤ margin < `min_gross_margin` → approver required (admin/director/manager); 403 otherwise
   - margin < `walk_away_margin` → director-level required (admin/director only); 403 otherwise
   - Admin override audited via `margin_guardrail`
3. **Validation guardrail** — `canFinalise` false → non-admin 409; admin override audited via `validation_guardrail`
4. **Discount guardrail** — pct > cap → non-admin 403; admin override audited via `discount_guardrail`

> **Important:** margin fires BEFORE validation. A quote with 0% margin gets 403, not 409.

### `computeMargin`

Uses `ledScreenDiscountedSell` (sums `l.sell × (1 − discount)` over `s.costBreakdown`) for LED sell. If `costBreakdown` is empty or all sells are 0, returns 0% → margin guardrail fires. This happens when a product has no `costPerSqmUsd` or bad cabinet dimensions.

### Settings-based guardrail thresholds

`min_gross_margin` and `walk_away_margin` are live-read from the `settings` table. They are mutated by integration tests in `z3-margin-tiers.test.ts`. If a test crashes before `afterAll`, the DB values remain corrupted for all subsequent test runs.

**Fix applied:** `z3-margin-tiers.test.ts` and `versioning-ruleset.test.ts` restore to **hardcoded canonical values** (0.28 / 0.22) in `afterAll`, not to a snapshot captured in `beforeAll`. This prevents corruption perpetuation if an earlier run crashed.

If tests are failing with 403 instead of 409/200 on the margin guardrail tests, check the live DB settings:
```bash
# Check current values
pnpm --filter @quotezen/db exec tsx -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const rows = await p.setting.findMany({ where: { key: { in: ['min_gross_margin','walk_away_margin'] } } });
console.log(rows); await p.\$disconnect();"
```
Expected: `min_gross_margin = 0.28`, `walk_away_margin = 0.22`.

## Migration workflow (RDS — no shadow DB)

The RDS user cannot create a shadow DB, so `prisma migrate dev` fails. Always author migrations with:

```bash
# 1. Author the SQL
pnpm --filter @quotezen/db exec prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel packages/db/prisma/schema.prisma \
  --script > packages/db/prisma/migrations/<timestamp>_<name>/migration.sql

# 2. Apply
pnpm --filter @quotezen/db exec prisma migrate deploy

# 3. Verify
pnpm --filter @quotezen/db exec prisma migrate status
```

`prisma migrate status` must always be clean before merging.

For enum value additions, use a separate `ALTER TYPE … ADD VALUE` migration — enum values don't surface in a column diff.

## Integration test setup

Tests use `app.inject()` (Fastify's HTTP injection) against the live RDS. Each test file:
- `beforeAll`: builds the app, logs in, finds required catalog rows (throw if missing)
- `afterAll`: deletes created quotes (by `jobReference` prefix), restores any mutated settings, closes app + DB

Test cleanup pattern:
```ts
const JOB_PREFIX = `TESTNAME-${process.pid}-`;
afterAll(async () => {
  await prisma.quote.deleteMany({ where: { jobReference: { startsWith: JOB_PREFIX } } });
  await app.close();
  await prisma.$disconnect();
});
```

When a test mutates `settings` rows, always restore to **hardcoded canonical values** (not a snapshot):
```ts
const CANONICAL = { min_gross_margin: '0.28', walk_away_margin: '0.22' };
afterAll(async () => {
  for (const [key, value] of Object.entries(CANONICAL)) {
    await prisma.setting.update({ where: { key }, data: { value } }).catch(() => undefined);
  }
  // ... rest of cleanup
});
```

## Content-type fix

`app.ts` has a permissive `application/json` content-type parser so bodyless POSTs (e.g. recompute) don't 400. The web client only sends `Content-Type: application/json` when a body exists.

## Admin generic CRUD

`admin/registry.ts` — one declarative entry per table drives a schema-driven router: list (search + pagination), get, create, update, delete, export CSV, import CSV. Zod validation built from field types. Admin audit writes a diff'd `admin_audit_log` row in-transaction on every CRUD + export.

## Feature build history (API blocks)

All blocks also have web counterparts — see `apps/web/CLAUDE.md` for the UI side.

### Blocks 1–6 — Foundation
- Auth (JWT, roles), quote CRUD + audit, catalog endpoints, PDF export, per-user scoping
- Generic admin CRUD (registry-driven)
- `packages/calc` integration for LED pricing

### Block 7 — Phase-1 deterministic completion
- `GET /health` (liveness) + `GET /ready` (DB → 503)
- `assertConfig()` exits 1 on bad env
- Controller auto-selection: `selectController` (pixel-threshold → smallest sufficient controller)
- `GET /quotes/:id/validate` → per-screen findings + `canFinalise`; `changeStatus` blocks on errors
- `POST /quotes/:id/price` — itemised price; cost admin-masked (BR-081)
- `POST /quotes/:id/screens/configure` — ranked LED configs (manufacturer priority, size bands)
- `GET /quotes/:id/{descriptions,bom,solution-summary,pm-handoff}` — proposal outputs
- `GET/PUT /quotes/:id/terms` — editable proposal text; captured in snapshots
- `PUT /quotes/:id/led-screens/:id` / `PUT …/lcd-screens/:id` — full re-edit endpoints
- `POST /quotes/:id/archive` + `restore`; `POST /quotes/:id/rerun`; file upload/download
- `GET /quotes/discount-policy` — live cap + threshold
- `POST /admin/:resource/export` (CSV) + `POST …/import` (dry-run + upsert)
- `GET/PATCH /admin/margins` — 13 commercial multipliers
- `deprecated` flag on 23 catalog models; `onDelete: Restrict` on quote→catalog FKs

### Block 8 — Full LED/LCD screen inputs
- `orientation`, `aspect_ratio_id`, `back_cover`, `frame_note` on `quote_led_screens`
- `orientation` on `quote_lcd_screens`
- `addLcdScreen` / `computeLcdScreenPricing` — full LCD pricing with out-of-hours uplift

### Block 9 — Two-stage review + approval
- `technical_review` + `commercial_review` statuses; `quote_reviews` table
- `recordReview`: advances/kicks-back + audits; `changeStatus` blocks `→ issued` until both approved

### Block 10 — Manufacturer priority + client discount
- `manufacturers` table + `led_products.manufacturer_id`; `clients.discount_pct` + `quotes.discount_pct`/`discount_scope`
- `resolveDiscount` precedence: quote → client → tier → system default
- `configureScreen` sorts by `manufacturerPriority` first, then best-fit

### Block 11 — Per-line discount + discount mode
- `quote_led_cost_breakdown.discount_pct` + `quote_lcd_items.discount_pct` + `quotes.discount_mode`
- `stack` = both quote + line; `item_only` = line discounts suppress quote discount

### Block 12 — Environment + viewing distance filters
- `led_products.environment` (indoor/outdoor/both); `outdoor_brightness_nits` setting
- `configureScreen` filters by environment + `viewingDistanceM` (max pitch ≈ distance in metres)

### Block 13 — LCD validation + warranty/install pricing
- `validateLcdScreen`: `LCD_DISPLAY_REQUIRED` (error), `LCD_NO_MEDIAPLAYER`/`LCD_NO_BRACKET`/`LCD_NO_ORIENTATION` (warnings)
- `warranty_options.per_year_cost`; `install_methods.default_hours` + `hourly_rate_cost`
- Auto-line dedup on re-edit (strips prior auto lines before regenerating)

### Block 14 — Discount guardrail + unified create/edit
- `enforceDiscountGuardrail`: pct > `discount_cap_pct` (0.12) → non-admin 403; pct > `discount_note_threshold_pct` (0.05) without note → 422
- `GET /quotes/discount-policy` — live cap + threshold

### Block 15 — Z-series governance rules
- Z1: `director`/`manager` roles; `clients.tier`; `anomaly_rules` table (5 rules); financial bumper settings
- Z3: Two-tier margin guardrail (see Key service patterns above); lead-time buffer applied in API layer
- Z4: `evaluateAnomalies(quote)` — nonstandard-cabinet, discount>12% on A+, outdoor <2500nit, air-freight+lead<5wk, custom-engineering
- Z5: `/admin/engine` — financial bumpers + anomaly rules admin panel
- Z6: `client_tiers` table; `resolveDiscount` now layers tier discount; `/rules/client/:id/effective`

### Block 16 — Theme preference
- `users.theme_preference`; `GET /auth/me` returns `themePreference`; `PATCH /auth/me` persists it

### Block 18 — Per-model priority
- `led_products.priority` (default 100); config engine secondary sort key after `manufacturerPriority`

### Block 19 — Fuller rule capture in version snapshots
- `captureRuleSet(quote)` freezes: margin bands, discount policy, resolved discount, clientTier, anomaly rules, financial bumpers, manufacturer priorities
- `SnapshotRuleSet` fully typed; defensive (missing setting → null, never throws)

### Blocks AA1–AA7 — Intake questionnaire + engine alerts
- AA1: `end_customer`, `airside_landside`, `sun_exposure`, `wall_substrate`, `power_data_available`, `controller_location`, `window_facing`, `recess_depth_mm`
- AA2: `compatibility_group` on products/controllers/frames; `allowed_ratios` per client; `content_ratio`/`content_supplier`/`flatness_required`; validation rules
- AA3a: LCD constraint rules (depth, Android, bracket sub-range, PC dependency)
- AA3b: `POST /quotes/:id/lcd-options` — LCD Good/Better/Best tiers (`selectLcdTiers`)
- AA4: `coating_options` lookup + `coating_id`/`high_resolution` on LED screens; `computeLedScreenPricing` adds coating line + high-res uplift
- AA5: `media_player_supply`, `shared_device_players`/`screens`, `store_size_sqm`, `custom_content_curation`, `pc_required`, `hard_drive_required`
- AA6a: `price_sensitivity`, `budget_aud`, `tenure_months`, `client_must_haves`, `needs_solutions_engineer`; `SOLUTIONS_ENGINEER_REVIEW` + `FREIGHT_MODE_RECOMMENDATION` advisories
- AA6b: `freight_overrides` lookup; `resolveFreightOverride(locationId, manufacturerId)` — most-specific match; fast-path `null` on empty table (strict no-op by default)
- AA7: `evaluateEngineAlerts(quote)` — `UNUSUAL_PRICE` (sell $/m² vs median historical, min 2 priors) + `CUSTOM_METALWORK_LEAD` (info); `unusual_price_deviation_pct` setting (default 0.30)
