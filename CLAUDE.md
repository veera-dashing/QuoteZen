# QuoteZen — Project Guide

Commercial **quoting engine** for Seen Technology (digital-signage / AV). It builds multi-component
client proposals by combining hardware catalogs, custom manufacturing, regional labour rates,
logistics, and recurring software licences into a single quote — replacing a complex Excel workbook
(`2026-XXX Quote Base V1.3`) with a relational, audited, web-based wizard.

> **Source of truth for the domain:** the original workbook. Sheets → our model:
> Reference Data, PI, Summary, (LED 1), (LCD 1), LCDRef, Licence & Support, Manufactured, Audio,
> Music, Software Costs, Hypervsn, Installer Breakdown, Import.

## Stack & layout (monorepo)

pnpm workspaces + Turborepo. TypeScript everywhere, `strict` + `noUncheckedIndexedAccess`.

```
quotezen/
├─ apps/
│  ├─ api/        Fastify REST API (JWT auth, quote CRUD, audit, recompute)
│  └─ web/        Next.js 16 (App Router) — the quote wizard
├─ packages/
│  ├─ db/         Prisma schema (58 tables) + migrations + xlsx seed
│  ├─ calc/       pure pricing engine (replicates Excel formulas) — heavily unit-tested
│  └─ shared/     shared TS types + Zod schemas + money helpers
```

**Dependency direction:** `shared` ← `calc` ← (`api`, `web`); `db` ← (`api`, seed). `calc` is pure
(no DB, no IO) so it is trivially testable and runs in the browser for live preview.

## Commands

| Command | What |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm test` | run every package's unit tests (Vitest) |
| `pnpm typecheck` | `tsc --noEmit` across the repo |
| `pnpm lint` | ESLint across the repo |
| `pnpm build` | build all packages/apps |
| `pnpm db:generate` | Prisma client codegen |
| `pnpm db:migrate` | run dev migration |
| `pnpm db:seed` | seed reference data from the xlsx |
| `pnpm --filter @quotezen/calc test` | test a single package |

Postgres connection via `DATABASE_URL` (see `.env.example`).

## Data model (58 tables, fully relational — no JSON blobs)

Three layers. Every lookup is its own table; quote rows carry **real foreign keys** into them.

1. **Auth & audit (4):** `roles`, `users`, `quote_audit_log` (field-level who/when/old→new on the
   quote and every child), `quote_revisions` (named save-points).
2. **Reference / catalog (≈40):** the **product master** — admins CRUD here, and any new product is
   immediately available to quotes. Currency (`currencies`, `exchange_rates`, `settings`,
   `seafreight_rates`), freight/location (`freight_options`, `locations`), LED domain
   (`led_products` ~230 rows w/ full specs, `led_commentary`, `controllers`, `led_peripherals`,
   `gob_options`, `trim_options`, `hanging_bar_options`, `frames`, `engineering_options`,
   `install_methods`, `access_equipment`, `warranty_options`, `service_hours_options`,
   `screen_ratios`), hardware (`mediaplayers`, `peripherals`), catalogs (`display_catalog` = the
   543-row LCDRef master with a `category` discriminator covering screens/mediaplayers/peripherals/
   networking/brackets/shrouds, `import_catalog` = Philips Q-Line, `manufactured_products`
   [+ optional `manufactured_components` / `manufactured_bom`]), labour (`installer_rates`),
   licence/support (`licence_components`, `hardware_support_components`,
   `international_support_rates`, `international_install_rates`, `international_vat`),
   software (`software_activities`), and `audio_products`, `music_services`, `hypervsn_products`,
   `clients`.
3. **Quote transactional (≈14):** `quotes` (header + quote-level PI: job ref, requested ship date,
   est/actual cost rollup), `quote_led_screens` (the LED-1 questionnaire as a row: input FKs +
   computed PI/spec output columns + price snapshot), `quote_led_components` (flexible FK'd list of
   controllers/mediaplayers/peripherals attached to a screen — `CHECK num_nonnulls(...)=1`),
   `quote_led_cost_breakdown`, `quote_lcd_screens`, `quote_lcd_items`, `quote_mediaplayers`,
   `quote_peripherals`, `quote_manufactured_items`, `quote_audio_items`, `quote_music_items`,
   `quote_hypervsn_items`, `quote_software_items`, `quote_licences`, `quote_terms`.

### Key modelling decisions
- **Catalog vs quote separation:** products live only in the catalog; quotes reference them by FK.
  Spec/price columns on `quote_*` rows are **computed outputs + a point-in-time price snapshot**, so
  an issued quote does not change when the catalog is later edited.
- **Dependent components are a flexible FK'd list** (`quote_led_components`, `quote_lcd_items`), not
  hardcoded slots — a screen can carry N components and a new component type needs no schema change.
- **PI (Project Information)** is per-screen site-prep data → lives on `quote_led_screens` /
  `quote_lcd_screens`; only truly quote-wide fields (job ref, ship date, est/actual cost) sit on
  `quotes`.
- **Money** is Postgres `NUMERIC` / Prisma `Decimal` — never float. Use `packages/shared` money
  helpers; do not do arithmetic on `Decimal` with JS `+`/`*`.

## Pricing engine (`packages/calc`)

Pure functions replicating the workbook. Known constants (from Reference Data) drive it:
Assembly Labour $45, Philips Markup 1.4, LCD Margin 0.30, LED Margin 0.33, Other Equipment 1.6,
Metalwork 1.5, Service 1.65, etc.; licence tiering ($270 site + $125/screen low-volume → $395 first
screen, $495 interactive, $125 subsequent). Tests assert against **known sample outputs** from the
Summary sheet (LED total `12380`, LCD total `10120`). When a formula is uncertain, extract it from
the workbook in formula mode rather than guessing — never hardcode a magic number without a source.

## Conventions (production-grade)

- **Layering (api):** `routes` (HTTP + Zod validation) → `services` (business logic, audit) →
  `repositories` (Prisma). No Prisma calls in routes.
- **Validation:** every external input parsed with a Zod schema from `packages/shared`. Reject early.
- **Errors:** typed errors → consistent JSON envelope `{ error: { code, message, details? } }`.
- **Audit:** all quote mutations go through a service helper that writes `quote_audit_log` in the
  same transaction as the change. Never mutate a quote without an audit row.
- **Tests:** Vitest. `calc` = exhaustive unit tests; `api` = service + integration tests; co-locate
  as `*.test.ts`. A change to pricing logic **must** come with a test.
- **Naming:** DB `snake_case`; TS `camelCase`; types/components `PascalCase`. Files `kebab-case.ts`.
- **No `any`** (lint-enforced). Prefer `unknown` + narrowing.

## Status (build progress)
Each module ships with its tests before the next begins.

- ✅ **Scaffold + tooling** — pnpm/turbo, tsconfig, eslint/prettier, CLAUDE.md.
- ✅ **packages/shared** — money helpers (decimal.js), enums, Zod schemas. 9 tests.
- ✅ **packages/calc** — currency, geometry, LED supply/spec, sea freight, licence tiering,
  priced-line composition, quote aggregation. 27 tests, all traceable to workbook values.
- ✅ **packages/db** — full 58-table Prisma schema; migration applies cleanly; idempotent seed
  loads the reference data (verified live against Postgres 16 in Docker).
- ✅ **apps/api** — Fastify REST: JWT auth, role guard, ~25 catalog read endpoints, quote CRUD with
  **in-transaction field-level audit logging**, status transitions, recompute (via packages/calc).
  Layered routes→service→repository, typed error envelope, Zod validation. 6 integration tests
  pass against the live RDS; live server smoke-tested.
- ✅ **Full catalog import** — `extract_catalog.py` → `prisma/data/catalog.json` → `import-catalogs.ts`
  loaded ~850 rows into RDS (177 LED products, 464 displays, 68 Philips, 47 audio, hypervsn, music,
  software, commentary, international rates/vat, hardware support). `pnpm --filter @quotezen/db import`.
- ✅ **Generic CRUD API** — `admin/registry.ts` (one declarative entry per table) drives a
  schema-driven router: `GET /admin/_meta`, list (search + pagination), get, create, update, delete,
  with Zod validation built from field types. 6 admin tests pass.
- ✅ **apps/web** — Next.js 16 admin/data-browser: login, grouped sidebar of all ~33 tables, generic
  data table (search/paginate), and add/edit/delete forms driven by `/admin/_meta`. Builds clean;
  verified live in-browser against RDS (177 LED products listed, CRUD working).

**Demo logins:** `admin@quotezen.local` / `sales@quotezen.local`, password `demo`.

- ✅ **Quote wizard** — backend: `POST /quotes/:id/{led-screens,lcd-screens,licences}` (LED priced
  via packages/calc: geometry + supply + components + frame/GOB, audited), recompute aggregates.
  Frontend: `/quotes` list, `/quotes/new`, and a 5-step editor (Details · LED · LCD · Licences ·
  Review) with skippable steps, live pricing, recompute totals, workflow buttons, and the change-
  history view. Verified live in-browser (LED screen priced at AUD 5,046.92 = the calc unit-test value).

**Run the whole thing:**
```bash
pnpm --filter @quotezen/api dev    # API on :4000 (loads root .env)
pnpm --filter @quotezen/web dev    # web on :3000  → /quotes
```

> **Bugfix note (content-type):** browser `fetch` sets `Content-Type: application/json` even on
> bodyless POSTs (e.g. recompute); Fastify's default rejects an empty JSON body with 400. Fixed by a
> permissive `application/json` content-type parser in `app.ts` + the web client only sending the
> header when a body exists. Regression test in `quotes.test.ts`.

- ✅ **LED install/labour pricing** — `calc/install.ts` (`ledInstall` + `estimateInstallHours`):
  labour hours × (assembly rate + location uplift) + access + freight, × service markup;
  engineering passed through. Wired into the LED screen service, so `priceServices` and `labourHours`
  /`freightKg` are now real (e.g. AUD 371.25 services on the sample screen). 5 calc tests.
- ✅ **PDF export** — `GET /quotes/:id/export.pdf` via pdfkit (offline, no headless browser); web
  "Export PDF" button auth-fetches the blob and downloads it. Tested (`%PDF` magic bytes).
- ✅ **Per-user scoping** — `assertOwnership` + scoped list: sales see only their own quotes (403 on
  others'); admins see all. Applied to every `/quotes/:id*` route. Tested.

### Estimation platform — Phase 1 deterministic gaps (branch `feat/estimation-platform`)
Implemented against `SEEN_Estimation_Consolidated.csv`. Order: config+validation+pricing → outputs →
versioning/governance. Google OAuth + Zoho + all AI (Phase 2) deferred by decision.
- ✅ **Config engine (P1-13)** — `calc/config.ts` `configureScreen`: iterates the LED catalogue, snaps
  each product to whole cabinets (with rotation + dedupe), computes fill %, resolution, ratio,
  cut-cabinet flag, quantities; ranks by closest-area fit with stable tiebreaks; empty-with-reasons on
  no fit. `POST /quotes/:id/screens/configure` runs it over the live catalogue; wizard LED step shows
  the ranked table → pick one to add. Verified live (280 ranked configs for 1120×1920).
- ✅ **Validation engine (P1-15)** — `calc/validation.ts` `validateScreen`/`canFinalise`: GOB-required
  (<2.5mm), outdoor deps (sensor + multifunction card + high-temp player), controller↔pixels,
  frame↔dims, portrait, video-wall; severities error/warning/cannot_evaluate (partial data never a
  false error).
- ✅ **Pricing add-ons (P1-16)** — spares (10%, configurable), packaging %, receiver-cards/cabinet
  (config-driven, 0 until set) in `calc/led.ts`; freight weight = MAX(volumetric, actual); all wired
  into screen pricing. `PricingConfig.addOns` + settings (`spares_pct`/`packaging_pct`/
  `receiver_card_cost`). **Itemised price** `POST /quotes/:id/price` returns every stored line with
  raw **cost masked for non-admin** (sell-only); admin sees cost (BR-081). Tested.
- ✅ **Quote outputs (P1-18)** — `calc/descriptions.ts` deterministic per-screen descriptions;
  `outputs.ts` builds procurement **BOM/PI** (components + cost lines, cost role-gated), **solution
  summary**, **PM handoff**; proposal **PDF** now includes descriptions + assumptions/exclusions/T&Cs.
  Endpoints `GET /quotes/:id/{descriptions,bom,solution-summary,pm-handoff}`; wizard Review has a
  **Documents** panel. Tested + verified live.
  - *Refinement:* descriptions use the raw geometric ratio (gcd, e.g. 7:12); switching to the named
    `screen_ratios` label (9:16) is a small follow-up.
### Block 3 — versioning & governance (branch `feat/versioning-governance`, off estimation-platform)
- ✅ **Versioning & snapshots (P1-04)** — `quote_revisions.snapshot` (JSON, immutable historical
  artifact) via migration `add_quote_version_snapshot`. `versioning.ts`: `createVersion` (full quote
  snapshot), `listVersions`, `getVersionSnapshot`, generic flatten-based `diffVersions`, and
  history-preserving `rollbackToVersion` (recreates the screen tree from the snapshot + recompute +
  records a new version with `restoredFrom`). Endpoints `POST/GET /quotes/:id/versions[/:rev][/rollback]`
  + `/versions/diff`. Wizard Review has a **Versions** panel (save / list / roll back).
- ✅ **Margin guardrail (P1-19g.2)** — `margin_floor` setting; `computeMargin` from the stored
  cost/sell breakdown; `changeStatus` blocks finalisation (`approved`/`issued`) below the floor for
  non-admins (403, names the floor), allows admin override (audited via `margin_guardrail`). Margin +
  floor surfaced in `/price` (admin-only). Status errors shown in the Review workflow card.
- ✅ **RBAC user management (P1-19g.1)** — admin-only `GET /admin/users` (no password exposure),
  `PATCH /admin/users/:id` (role / isActive), `GET /admin/roles`; web **Users & roles** admin page.
- **Settings added:** `spares_pct`, `packaging_pct`, `receiver_card_cost`, `margin_floor` (seeded).
- **Migrations note:** the RDS user can't create a shadow DB, so `migrate dev` fails — author the
  migration with `prisma migrate diff` and apply via `prisma migrate deploy`.

### Block 4 — concurrency, client overrides, ratio fix (branch `feat/versioning-governance`)
- ✅ **Optimistic concurrency (P1-05.2)** — `quotes.lock_version` token (migration); `updateQuote`
  rejects a stale `expectedVersion` with **409 conflict** (never last-write-wins) and bumps the token;
  `changeStatus` also bumps. Tested.
- ✅ **Client overrides + rule resolution (P1-10)** — `clients` gains `preferredProductFamily`,
  `preferredPitchMm`, `excludedComponents` (+ existing `defaultMargin`), editable via the admin CRUD.
  `GET /rules/client/:id/effective` merges global + client with `overridesGlobal` indicators; the
  **margin floor guardrail wins** over a below-floor client margin (P1-10.4). Tested.
- ✅ **Named-ratio descriptions** — auto descriptions now use the named `screen_ratios` label (9:16)
  via `loadRatios()`, threaded through descriptions/BOM/PDF. Tested.

**Still backlogged (later passes):** file upload + re-run (P1-19e, needs object storage + AV scan),
KB capture (P1-19f), audit-viewer filters + cross-quote admin view (P1-03.3), bulk-import wizard UI
(P1-06.4), Google OAuth + Zoho, and all Phase 2 AI. (Concurrency-token UI wiring and a client
rule-resolution view are thin follow-ups — the APIs are done and tested.)

**Local Postgres for dev/tests:**
```bash
docker run -d --name quotezen-pg -e POSTGRES_USER=quotezen -e POSTGRES_PASSWORD=quotezen \
  -e POSTGRES_DB=quotezen -p 5433:5432 postgres:16-alpine
# packages/db/.env → DATABASE_URL=...localhost:5433/quotezen
```
