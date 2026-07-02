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

**Role-aware UI:** the web stores the session user (`getRole()` from the login response, falling back
to decoding the JWT) and filters navigation by role. Admin sees everything; **sales** sees Quotes +
Knowledge base + Reference data (no Users/Audit); **viewer** is redirected to `/quotes`, sees only
their assigned quotes read-only (no Reference-data link, no "+ New quote"). This is UX layering on top
of the server-side RBAC, which remains the enforcement boundary.

**UI note:** dropdowns use a reusable searchable combobox `apps/web/components/SearchSelect.tsx`
(type-to-filter popover; click-away/Esc to close) instead of native `<select>` — used for client/
location/currency, LED product (~177) & display pickers, admin form enums, and the user role picker.

**Demo logins (password `demo`):** `admin@quotezen.local` (admin = full), `sales@quotezen.local`
(sales = write, own quotes only), `viewer@quotezen.local` (viewer = read-only). The login page has
one-click **Quick login** buttons for each. **RBAC:** quote mutations require `admin|sales` (viewer is
read-only); admin-only = Users/roles + cross-quote Audit; admin sees cost + can override the margin
floor. **Quote access:** admin sees all; others see quotes they created **or are assigned to as a
viewer** (`quote_viewers` join). Assign viewers at quote create/edit (`viewerUserIds`); `GET
/users/viewers` lists assignable viewers; the new-quote form has a "Share with viewers" picker.

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

### Block 5 — KB capture + audit viewer (branch `feat/versioning-governance`)
- ✅ **KB capture (P1-19f)** — `kb_entries` table (migration); `captureKbEntry` auto-snapshots a quote
  (client/location/products/screen count/grand total/margin/outcome) into the KB when it reaches an
  outcome state (`issued`/`won`/`lost`), inside the status transaction. `GET /kb` (admin/sales,
  filterable by outcome/client). Web **Knowledge base** admin page. Storage only — no AI. Tested.
- ✅ **Audit viewer (P1-03.3)** — `GET /quotes/:id/audit` now takes filters (field/user/action/
  from/to); admin-only `GET /admin/audit` is the cross-quote feed (joins quote ref + user). Web
  **Audit log** admin page with an action filter. Verified live.

### Block 6 — concurrency UI, rule-resolution view, dropdown polish (branch `feat/versioning-governance`)
- ✅ **Editable Details step + optimistic-concurrency UI** — the quote wizard's Details step is now
  editable (job ref, client, location, currency, viewer sharing) instead of read-only. Save sends
  `expectedVersion: quote.lockVersion`; a stale token surfaces a **409 conflict banner** ("changed
  elsewhere…") with a **Reload latest** button, and the lock token (`v{n}`) is shown in the card header.
  Viewers still get the read-only variant. To support *clearing* a client/location, `updateQuoteSchema`
  makes `clientId`/`locationId` `nullish()` (the service already maps `null` → FK cleared). Verified
  live: 409 on stale save, happy path bumps v1→v2 and persists.
- ✅ **Client rule-resolution view (P1-10.3)** — web **Effective rules** admin page (admin/sales): pick
  a client → `GET /rules/client/:id/effective`, rendered as a resolved-values table with
  global-default / **client-override** source badges and the margin-floor clamp shown inline
  (effective = floor when the client margin is below it). Verified live (override + clamp).
- ✅ **Licence-step dropdowns → SearchSelect** — the screen-type / volume-tier native `<select>`s now
  use the searchable combobox, matching the rest of the wizard.

### Block 7 — Phase-1 deterministic completion (multi-agent build, branch `feat/versioning-governance`)
Delivered the remaining Phase-1 deterministic gaps (everything except Google OAuth, Zoho, and all
Phase-2 AI, which stay deferred), orchestrated as one subagent per feature. Full repo green after:
**142 tests** (9 shared + 71 calc + 62 api), typecheck + build clean.
- ✅ **Health/readiness + fail-closed boot (P1-01.3/.4)** — `GET /health` (liveness, no DB) + `GET /ready`
  (DB check → 503, generic body); `assertConfig()` exits 1 at boot naming any missing/invalid env.
- ✅ **Lightweight CI (P1-01.1 subset)** — `.github/workflows/ci.yml`: install → db:generate → lint →
  typecheck → migrate:deploy → seed → test → prisma validate + migrate-diff drift check, on PR + push
  to main, with a `postgres:16` service container (no secrets). No deploy/Terraform/Docker.
- ✅ **Controller auto-selection (P1-09.3/.4)** — calc `selectController`: pixel-threshold → smallest
  sufficient controller (`max_pixels`, inclusive), multi-controller count + flag on over-capacity,
  never throws. 14 tests.
- ✅ **Validation/conflict engine wired (P1-15)** — `GET /quotes/:id/validate` maps screens to calc
  `validateScreen` → per-screen findings (error/warning/cannot_evaluate) + `canFinalise`; `changeStatus`
  blocks finalisation on errors for non-admins (409), admin override audited (`validation_guardrail`),
  alongside the margin guardrail. Wizard **Validation card** + Approve/Issue gating.
- ✅ **Itemised price view (P1-16.8/.10)** — Review "Itemised price" card over `POST /quotes/:id/price`;
  Cost column admin-only (masked note otherwise), margin + floor with below-floor flag, viewer-gated.
- ✅ **Fuller per-screen input form (P1-12.2/.3)** — LED step "Options & services": 10 searchable
  lookups (frame/trim/hanging-bar/engineering/install/freight/warranty/service-hours/access/GOB) threaded
  into both add paths; required-field gating (product + W + H) with inline hints.
- ✅ **Version diff UI (P1-04.2/.4)** — "Compare versions" card: pick A/B, `GET /versions/diff`,
  added/removed/changed row tinting, structurally-different handled.
- ✅ **Screen management (P1-14)** — `sort_order` migration; duplicate (deep-copy + components +
  breakdown), reorder, per-screen qty (`PATCH …/qty`, rejects 0/neg) multiplied into the rollup;
  ▲/▼/Qty/Duplicate UI. (LCD qty stays on item rows.)
- ✅ **Rule-set snapshot + missing-rate hard stop (P1-04.1/.07.5/.16.9)** — versions embed the rule-set
  in force (`snapshot.ruleSet`: markups/freight/addOns/rates/marginFloor); pricing hard-stops (400)
  naming a missing rate (selected freight option w/o rate; absent USD FX) — never defaults silently.
- ✅ **Editable, versioned proposal text (P1-18.2)** — `quote_term_kind` migration; `GET/PUT
  /quotes/:id/terms`; PDF renders stored terms grouped by kind with per-group default fallback;
  Review "Proposal text" editor (viewer read-only). Captured in snapshots automatically.
- ✅ **Editable fields & overrides (P1-17)** — `quote_overrides` table; `setOverride`/`clearOverride`
  (audited); **pinned recalc** (overridden screen sell pins → downstream totals recompute);
  `computeMargin` reflects overrides so the below-floor guardrail triggers (non-admin 403, admin
  audited); orphan cleanup; 🚩 badge + original/who/why hover + Clear in the itemised price card.
- ✅ **Soft-delete/archive + auto-save (P1-05.1)** — `quote_archive` migration; `POST /quotes/:id/
  archive`+`restore` (never hard-delete, audited); list excludes archived by default (`?archived=true`);
  active/archived toggle + per-row Archive/Restore; debounced Details auto-save (token refresh, pauses
  on conflict).
- ✅ **File upload + deterministic re-run (P1-19e)** — `@fastify/multipart`; **local-disk** storage
  (`UPLOAD_DIR`, default `<repo>/.uploads`, gitignored; AV scan deferred w/ TODO hook); `quote_documents`
  migration; upload/list/download/delete (filename sanitised, mime+ext allowlist, size guard, versioned);
  `POST /quotes/:id/rerun` = recompute + new version labelled with the total change. Files & re-run card.
- ✅ **Quote management dashboard (P1-19d)** — `GET /quotes` gains status/clientId/q/from/to filters
  (composed with per-user scope + archive); Drafts/Finished/All/Archived tabs + search/client/date
  controls; shared `computeQuoteTotals` powers a non-mutating `GET /quotes/:id/recompute-preview`
  (reopen drift: current vs recomputed).
- ✅ **Bulk CSV import/export (P1-06.4/.5)** — `GET /admin/:resource/export` (admin-only, BR-081) →
  CSV; `POST …/import/preview` (dry-run report) + `POST …/import` (all-or-nothing upsert in one tx:
  422 on invalid, 409 on dup-key, rollback leaves table unchanged), reusing the registry Zod coercion
  (csv-parse/csv-stringify). Admin import wizard UI.
- ✅ **Admin audit + export gating + margins editor (P1-06.6/.07.2/.07.6)** — `admin_audit_log` migration
  (append-only); every admin CRUD + export writes a diff'd audit row in-transaction; `GET/PATCH
  /admin/margins` edits the 13 commercial multipliers in one view (bulk tx, audited) + `/admin/margins`
  page; reference-data audit viewer.
- ✅ **Deprecate-not-delete (P1-08.4/.11.4)** — `deprecated` flag on 23 catalog/lookup models; flipped
  `quote_*→catalog` FKs to `onDelete: Restrict` (prevents silent snapshot-FK nulling); admin DELETE
  catches P2003 → deprecates instead (audited), unreferenced rows still hard-delete; `?activeOnly=true`
  + config engine + wizard exclude deprecated from NEW quotes while existing quotes retain their rows.

**Migration note:** all the above were authored RDS-safe (`prisma migrate diff --from-url $DATABASE_URL
--to-schema-datamodel … --script` → `prisma migrate deploy`, since the RDS user has no shadow-DB
permission) and `prisma migrate status` is clean.

### Block 8 — full LED/LCD screen inputs from the source workbook (`(LED 1)` / `(LCD 1)`)
Brought the per-screen input flow up to the `2026-XXX Quote Base V1.3` questionnaires (extracted spec in
the workbook's `(LED 1)`/`(LCD 1)` sheets). Most fields were already modelled (the DB was built from this
workbook); this exposed the rest in the wizard + added the input-time rules. 146 tests green.
- ✅ **S0 — schema + backend** — migration `screen_input_fields`: `quote_led_screens` gains
  `orientation`, `aspect_ratio_id` (FK screen_ratios), `back_cover`, `frame_note`,
  `service_description_suffix`; `quote_lcd_screens` gains `orientation`. `ORIENTATIONS` enum;
  `ledScreenSchema`/`lcdScreenSchema` + `addLedScreen`/`duplicateLedScreen`/`addLcdScreen` persist them.
- ✅ **S1 — LED full input form** — Orientation + Aspect-Ratio selectors with the workbook auto-dimension
  calc (long axis follows orientation, other axis derived from `ratioLabel`, editable); **component
  pickers** (controller / mediaplayer / LED-peripheral / mediaplayer-peripheral → catalog → qty, mapped to
  `ledComponentSchema`); Back Cover + frame/service notes. Threaded into both add paths; LED rules (GOB<2.5,
  outdoor deps, controller↔pixels, cut-cabinet, volumetric freight) already enforced by the validation/
  config/calc engines.
- ✅ **S2 — LCD full-fidelity form + pricing** — `LcdStep` reproduces the LCD-1 sheet: orientation/service-
  hours/warranty/install selectors + 6 sections (Display · Mediaplayer & Peripherals · Bracket & Shroud ·
  Configuration/Installation · Seen Labour · Location Fees) with category-filtered catalog pickers, manual
  rows + templates (parking $50, travel $75, induction, per-hour), per-section subtotals + live total.
  `addLcdScreen` resolves catalog cost server-side (snapshot), applies the fixed `lcd_margin` gross-up per
  line (Σ line sells == `priceTotal`, rounded to $10), and adds an **out-of-hours uplift** line when service
  hours ≠ "Business Hours". The uplift is a **labour-cost calc** (workbook F31 = SUM(K28:K29) × rate):
  install labour hours = install-line cost ÷ `install_hourly_cost` ($95/hr; site-attendance excluded, it
  divides by /135 and isn't in SUM(K28:K29)), charged at the LCDRef uplift rate `out_of_hours_rate_cost`
  ($50/hr) / `out_of_hours_rate_sell` ($80/hr). Persists screen/bracket/services subtotals; audited.

### Block 9 — Workshop "Capability Assessment" deterministic gaps (`Workshop 1 - Current State…` PDF)
Reconciled the manual 6-stage process + 8 target capabilities from the Propel Ventures workshop PDF
against the build. The deterministic quote-flow core (Capabilities 4 & 5 — tech config + commercial
estimation — plus versioning/audit/RBAC/governance) was already done and matches; the workshop's own
"where the LLM is used" map + MVP matrix put the LLM/Zoho/embedding parts as do-it-next / don't-do.
Built the four remaining **deterministic** gaps (AI/Zoho stay deferred). 160 tests green.
- ✅ **T1 — Two-stage review & approval (Capability 7 / BR-001 / FR-102-110)** — `technical_review` +
  `commercial_review` statuses; `quote_reviews` table (stage/decision/reviewer/comment + the reviewed
  `lockVersion`). `recordReview` advances/kicks-back + audits (no lockVersion bump, so both stage
  approvals share a revision); `changeStatus` blocks `→ issued` unless BOTH a technical AND a commercial
  `approved` review exist **for the current revision** (BR-001 — admins cannot bypass), alongside the
  margin + validation guardrails; a content edit re-arms the gate; history preserved (FR-110). `POST/GET
  /quotes/:id/reviews`; Review & approval UI card + history; Issue disabled until both approved.
- ✅ **T4 — Manual assumptions & risks register (Capability 2 manual / FR-038-041,095)** — `quote_risks`
  (category/severity/mitigation); `GET/PUT /quotes/:id/risks` + combined `GET …/register` (assumptions
  from `quote_terms` + risks); risks flow into the proposal PDF (high-severity red) + PM handoff (sorted
  high-first); ReviewStep register card with high-severity highlighting (viewer read-only). Manual capture
  only — AI gap/risk *detection* stays deferred.
- ✅ **T2 — Good/Better/Best options (Capability 6 / FR-057,067)** — calc `selectTiers`: Value (cheapest
  cost/sqm) / Recommended (best-fit) / Premium (finest pitch) over distinct products, each with a static
  rationale; `POST /quotes/:id/screens/options` prices each at the **supply level** (area × cost/sqm × FX ×
  LED markup) via the live PricingConfig, cost+margin admin-masked (BR-081), no persistence; LED-step
  comparison cards with "Use this option" → existing add path.
- ✅ **T3 — Ratio guardrail + over/under sizing (Capability 4 / FR-059-067, BR-033)** — `configureScreen`
  now emits fit+under+over variants per product/orientation (deduped); `ConfigOption` gains `sizeMode`
  (under|exact|over), signed `deltaWidth/HeightMm`, `sizeDeltaPct`, `ratioPreferred`, advisory
  `ratioGuidance` (preferred order 16:9,2:1,3:1,5:4,1:1,9:16 — non-blocking). Configure table shows a
  colour-coded Sizing column + ⚠ ratio-guidance flag.

### Block 10 — workshop manual-process refinements (PI, Select Screens, manufacturer priority, discount)
From the `Workshop 1` manual process + estimator MVP notes. Decisions (confirmed): size-tolerance bands,
quote-level PI on the first screen, a new Manufacturers table, override+floor-enforced client discount.
173 tests green (9 shared + 82 calc + 82 api). Built as 4 sequential subagents (U0→U2→U3→U1):
- ✅ **U0 — foundation** — migrations: `manufacturers` (name/priority/leadTimeDays) + `led_products.
  manufacturer_id` (seeded LEDFul p1/45d, ZonePro p2/60d, Muxwave p3/60d; 177 products backfilled);
  `clients.discount_pct` + `quotes.discount_pct`/`site_address`/`project_notes`; `settings.value_text`
  (for non-numeric settings). `default_client_discount_pct` applied on client create; `size_tolerance_bands`
  seeded `5,10,25`. `PATCH /quotes/:id/led-screens/:screenId` (`updateLedScreen` → shared
  `computeLedScreenPricing` re-price) powers the LED two-form. Manufacturers admin CRUD.
- ✅ **U2 — manufacturer ordering + lead time + size bands** — `configureScreen` sorts by
  `manufacturerPriority` first (lower=preferred), best-fit within; `ConfigOption` gains
  `manufacturerName`/`leadTimeDays`. `configureForQuote` reads `size_tolerance_bands`, annotates each
  option's `toleranceBand` (smallest band ≥ |sizeDeltaPct|) and **excludes over-band options** (counted in
  `reasons`). Options + good/better/best tiers carry manufacturer/lead-time/band.
- ✅ **U3 — client discount pricing** — `resolveDiscount` precedence quote→client→`default_client_discount_pct`;
  applied to the one-off (equipment+services) sell base in `computeQuoteTotals` (recurring excluded);
  `computeMargin` discounts the sell so the **below-floor finalisation guardrail auto-fires** (non-admin 403,
  admin override audited) — no guardrail duplication. `/price` returns `discount {pct,source,amount}` +
  discount-aware margin (admin-gated); `/rules/client/:id/effective` shows client vs system discount.
- ✅ **U5 — discount scope** — `quotes.discount_scope` (`one_off` | `recurring`, default one_off) chosen at
  quote creation + editable. `computeQuoteTotals` discounts the elected base (one_off → upfront
  equipment+services; recurring → the recurring/renewal total); `computeMargin` only discounts the one-off
  margin for `one_off` scope, so a recurring-scope discount never trips the one-off margin-floor guardrail.
  `/price` returns `discount.scope`; new-quote form + Details selector (One-off upfront / Every renewal).
- ✅ **U1 — wizard restructure** — `STEPS = Details · Select Screens · Licences · Review`. Details has a
  **Project information** block (requested shipping date, site address, project notes, quote-level discount
  override %) on the optimistic-lock PATCH. **Select Screens** merges LED+LCD behind an LED/LCD type toggle +
  one combined type-tagged screens list. **LED two-form**: Form 1 finalises panel+geometry+components; Form 2
  is a per-screen expandable "Options & services" editor (trim/frame/gob/.../back cover/notes) saved via the
  U0 PATCH (re-prices). Options show manufacturer (priority order) + lead time + tolerance band.

**Still backlogged (deferred by decision / needs infra):** the workshop's AI/Zoho capabilities — Opportunity
Intake (Zoho sync + AI doc/metadata extraction, Cap 1), Opportunity Analysis (AI gap/risk/clarification
detection, Cap 2), Knowledge Engine (vector similarity, Cap 3), Learning Engine (close-the-loop, Cap 8),
Zoho estimate push (Cap 6) — plus Google OAuth (P1-02) and all Phase-2 AI (P2-*); real S3 + AV scanning for
uploads (the prototype uses local disk); full Terraform/Docker/CD (CI is lightweight only).

**Local Postgres for dev/tests:**
```bash
docker run -d --name quotezen-pg -e POSTGRES_USER=quotezen -e POSTGRES_PASSWORD=quotezen \
  -e POSTGRES_DB=quotezen -p 5433:5432 postgres:16-alpine
# packages/db/.env → DATABASE_URL=...localhost:5433/quotezen
```

### Block 11 — cancel, screen re-edit, per-line discount + cost-breakdown drawer
From live UX feedback on the quote flow. 188 tests green (9 shared + 85 calc + 94 api).
- ✅ **Cancel in new-quote** — the create form has a Cancel (→ /quotes).
- ✅ **V2 — per-line discount + discount mode** — migration: `quote_led_cost_breakdown.discount_pct`
  + `quote_lcd_items.discount_pct` + `quotes.discount_mode` (`stack`|`item_only`, default stack).
  Per-line discounts fold into the screen effective sell + rollup + `computeMargin` (a pinned C-override
  still wins); the quote/client discount layers per `discountMode` (stack = both; item_only = quote
  discount suppressed when any line discount exists) — a per-quote user choice; the margin-floor
  guardrail fires off the fully-discounted margin. `PATCH /quotes/:id/led-lines/:id/discount` +
  `/lcd-items/:id/discount`; `/price` returns per-line discountPct + effectiveSell + discountMode.
- ✅ **V3 — full re-edit endpoints** — `PUT /quotes/:id/led-screens/:id` (updateLedScreenFull) +
  `PUT …/lcd-screens/:id` (updateLcdScreen) rewrite all inputs + re-price via the shared
  `computeLedScreenPricing` / factored `computeLcdScreenPricing` (create + update price identically);
  preserve id/sortOrder/qty; audited.
- ✅ **V4 — web** — ✎ Edit on every screen row re-opens the add form pre-filled (LED + LCD) → Save
  changes via PUT. 📊 quote-wide **Cost breakdown** right-drawer over `/price`: every screen's lines
  (Label/Qty/Cost admin-only/Sell/Disc%/Effective) + licences + totals; per-line discount % PATCHes
  led-lines/lcd-items by section type (live refetch); Stack vs Per-item-only discount-mode toggle
  (409-safe). Viewer read-only.

### Block 12 — pixel pitch by viewing distance, indoor/outdoor, GOB in screen suggestion
From live feedback: the LED screen suggestion query should be driven not only by size/aspect but by
**viewing distance**, **environment (indoor/outdoor)**, and **GOB (fine pitch)** — surfaced in the
FIRST part of the LED form and folded into the ranked configuration results. 203 tests green
(9 shared + 96 calc + 98 api).
- ✅ **W0 — config filters (backend)** — migration `w0_led_environment` adds `led_products.environment`
  (indoor/outdoor/both; nullable) + `ENVIRONMENTS` enum + admin registry field; setting
  `outdoor_brightness_nits` (4000) seeded. calc `configureScreen`: `effectiveEnvironment` (product field,
  falling back to brightness ≥ threshold ⇒ outdoor) filters by requested environment; a `viewingDistanceM`
  filter drops products whose pixel pitch exceeds the distance (max pitch ≈ distance in metres); every
  `ConfigOption` now carries `pixelPitchMm` + `gobRecommended` (pitch < 2.5mm). `ConfigConfidence` scoring
  unchanged. Threaded through `configureForQuote`/`optionsForQuote`; `configureSchema` gains optional
  `environment` + `viewingDistanceM`; empty-with-reasons on no fit (never an error). Tested (`w0.test.ts`).
- ✅ **W1 — first-section inputs (web)** — LED add form's first "Screen selection" card gains an
  **Environment & suitability** sub-section: **Viewing distance (m)** (optional number), **Environment**
  (SearchSelect Indoor/Outdoor, empty = "Any"), and **GOB (fine pitch)** moved UP from the post-selection
  options grid — bound to the SAME `gobId` state `addScreen()` sends (single source of truth). A shared
  `selectionBody()` threads `environment` + `viewingDistanceM` into both `configure()` and `loadTiers()`
  (sent only when set). Ranked table + Good/Better/Best cards show a **GOB** badge (tooltip: fine pitch —
  GOB recommended) + a sortable **Pitch (mm)** column. Web-only; no schema/API change.

**Note on W0 vs Block 11's `environment`:** the earlier W0 draft mentioned in prior context is this block;
`led_products.environment` is the only new catalog column. The indoor/outdoor decision uses the field first
and falls back to `brightness_nits ≥ outdoor_brightness_nits` when the field is null.

### Block 13 — LCD business-logic completion (validation + warranty/install pricing)
Closed the two LCD gaps found auditing the LCD tab against the LED side: LCD had no validation engine, and
`warrantyId`/`installMethodId` were captured but never priced. 219 tests green (9 shared + 104 calc + 106 api).
- ✅ **X1 — LCD validation/conflict engine** — calc `validateLcdScreen` (+ `LcdValidationInput`) mirrors the
  LED engine (same `ValidationFinding`/severity/`canFinalise`). Rules: **error `LCD_DISPLAY_REQUIRED`** (screen
  has items but no `display` line with a real `displayId`; zero items → `cannot_evaluate`), **warning
  `LCD_NO_MEDIAPLAYER`** (display present, no mediaplayer item, and the display description shows no built-in
  player — chromecast/android/built-in; no description → `cannot_evaluate`), **warning `LCD_NO_BRACKET`**,
  **warning `LCD_NO_ORIENTATION`**. `validate.ts` `lcdScreenToInput` appends LCD screens to the same
  `screens[]` aggregate, so `changeStatus`'s existing validation guardrail gates LCD errors too (non-admin
  409, admin override audited `validation_guardrail`) — no guardrail duplication; the Review Validation card
  renders LCD entries with no change (it maps `validation.screens` generically).
- ✅ **X2 — LCD warranty ($/extra-year) + install-method labour pricing** — migrations add
  `warranty_options.per_year_cost`, `install_methods.default_hours` + `hourly_rate_cost`, and the `warranty`
  value on the `LcdItemType` Postgres enum (a separate `ALTER TYPE … ADD VALUE` migration — enum values don't
  surface in a column diff). In `computeLcdScreenPricing`:
  - **Warranty** (fixed $/extra-year, beyond a 3-yr baseline): `extraYears = max(0, warranty.years −
    standard_warranty_years[=3])`; line `unitCost = extraYears × per_year_cost`, sell via `lcd_margin`;
    `Standard (3yr)` adds no line. Grouped into `priceServices`.
  - **Install-method labour**: if `default_hours > 0`, line `unitCost = default_hours × (hourly_rate_cost ??
    install_hourly_cost $95)`, sell via `lcd_margin`, pushed **before** the OOH block so it feeds the
    out-of-hours uplift hours; warranty pushed **after** so it never does.
  - **Auto-line dedup**: input items are stripped of prior auto lines (itemType `warranty`; `install` lines
    whose description starts `"Installation — "` or matches `/^Out of Hours uplift/i`) before regenerating —
    create + re-edit price identically and this **fixes a latent OOH double-count on re-edit**. The web edit
    form applies the same filter on load. Admin CRUD gains the new fields; seed placeholders ($150/yr,
    4 hrs) are **admin-editable** — the workbook has no warranty/install rate, so these are commercial
    defaults, not sourced constants. **Warranty & install method are otherwise still descriptive** where a
    rate isn't set (per_year_cost 0 / default_hours 0 ⇒ no line), so existing quotes are unaffected.

**Still LED-only by design:** LCD is fixed-size hardware, so it stays out of the best-fit config engine,
size-tolerance bands, and Good/Better/Best tiers (those are the LED "lego" flow).

### Block 14 — quote-level discount guardrail (A+) + UX polish
- ✅ **Inline cost breakdown** — the per-screen cost breakdown moved out of the right-side drawer to an
  expandable panel on each screen row in "Screens on this quote" (LED + LCD), with a "Quote totals"
  summary card (discount mode + totals + licences) beneath the list. `PriceSection` gained a uniform
  `screenId` (LED + LCD) so each row matches its section.
- ✅ **"Manufacturer - Model" screen labels** — screen rows show e.g. "LEDFul - ISD320 / IF1.5-160"
  (`ledScreenLabel`/`lcdScreenLabel`) when unnamed; a user-set name still wins. Quote include loads
  `ledProduct.manufacturer`.
- ✅ **Best-fit ⇄ Good/Better/Best are mutually exclusive** — running one clears the other in the LED
  add form (only the selected view shows).
- ✅ **Discount guardrail (A+)** — the quote-level discount override is **capped at 12%** and requires a
  **manager note above 5%**. Settings `discount_cap_pct` (0.12) + `discount_note_threshold_pct` (0.05),
  admin-editable; `quotes.discount_note` column (migration `quote_discount_note`). `enforceDiscountGuardrail`
  in the quote service runs on create + update over the EFFECTIVE pct/note: **> cap** → non-admin 403,
  admin override allowed + audited (`discount_guardrail`); **> threshold without a note** → 422. New-quote
  form + Details step show the note field (required >5%), cap/threshold hints, and gate save (auto-save
  suspends while unmet). Tested (`discount-guardrail.test.ts`); deep-discount margin/scope tests
  lift the cap to isolate the margin-floor behaviour.
  - *Cap is admin-maintained + hard-limited in the UI:* `discount_cap_pct` (and the note threshold) are
    edited in the admin **Settings (markups/margins)** page (label "Quote Discount Cap %"). `GET
    /quotes/discount-policy` (any authenticated user) returns the live cap + threshold from the DB; the
    quote page reads it so a **non-admin estimator's input is clamped to the cap** (input `max` = cap;
    typing above it snaps back) — admins may still exceed it (audited). Verified live: sales input max=12,
    typing 20 → 12. 226 tests green (9 shared + 104 calc + 113 api).
- ✅ **Unified create + edit (no duplicate Details screen)** — the standalone `/quotes/new` page was
  removed; `/quotes/new` now resolves to the same wizard (`[id]` route with `id === 'new'`) with the
  **Details step in create mode**. Create mode: title "New quote", later steps locked until the draft
  exists, "Create & continue" button → `POST /quotes` then `router.replace('/quotes/:id?step=1')` so the
  user lands on **Select Screens** (Details is shown once, not twice). Edit mode is unchanged (opens on
  Details with auto-save + version badge; `?step=n` deep-links a step). `DetailsStep` takes `quote:
  Quote | null` and branches create/edit off one shared body (nulls stripped for the create schema);
  auto-save/optimistic-lock only run in edit mode.
- ✅ **LCD form + pricing faithful to the `(LCD 1)` workbook tab** — reconciled against the source tab
  (extracted with openpyxl in formula mode). The item breakdown now shows the tab's columns per line
  (**Description · Cost · Sell(list) · Qty · Price · Margin**; Cost + Margin admin-gated, BR-081) with
  per-section subtotals, and the **quoted total is the fixed-margin total, not the sum of line sells**:
  `priceTotal = ROUND(Σ(cost×qty) / (1 − lcd_margin), −1)` (tab G54; canonical sample cost 7085 → **10,120**;
  the list sells sum to 10,169 — the deliberate tab discrepancy). Per-line **Sell** = `display_catalog.sell`
  (list) for catalog rows, `cost × service_markup` (1.65) for manual rows. Section subtotals mirror the tab's
  per-section fixed-margin analysis (G51/G52/G53). `lcdScreenDiscountedSell` returns `priceTotal ×
  (Σ discounted cost / Σ cost)` — SYNC, so with no discount the screen sell == the tab total and a per-line
  discount lowers it proportionally (keeps `computeMargin`/`computeQuoteTotals`/`priceQuote`/V2 coherent).
  `lcd-tab-pricing.test.ts` + updated S2/x2/v3 expectations. 227 tests green (9 shared + 103 calc + 115 api).
- ✅ **LCD-tab automations completed** — the remaining `(LCD 1)` conveniences: (1) **auto service
  description** (`describeLcdScreen`: model + "in-built SeenCMP mediaplayer"/external players +
  components + Landscape/Portrait + warranty, tab B2) wired into BOM/solution/PM-handoff/PDF; (2) **auto
  Media Player Configuration qty** = count of selected mediaplayers (tab F23); (3) **location-driven
  travel uplift** (tab row 30) = `location.hourly_uplift × total install hours` (site-attendance ÷135,
  other install ÷95), sell = cost × `service_markup` (1.65), added only when uplift>0 (Melbourne 0 → no
  line, so the sample stays 10,120); regenerated on re-edit via the auto-line strip ("Location travel
  uplift" prefix); (4) **Order List** string ("N × display, N × bracket…", tab B56) in the outputs;
  (5) **Analysis block** (Hardware/Bracket/Services @ nominated margin + Total At Fixed Margin, tab rows
  47–54) shown in the LCD form. `lcd-automations.test.ts` (4) + `describeLcdScreen` calc tests. 234 tests
  green (9 shared + 110 calc + 119 api). No migration (all derivable from existing columns).

### Block 15 — Engine constraints & systemic rules (governance) — Z-series
From the "Engine constraints & systemic rules" + "Tiers & per-client rules" workshop mockups. Built as
six ordered blocks (Z1–Z6), each verified against the full live-RDS suite before the next. Final:
**247 tests green (9 shared + 110 calc + 133 api)**; typecheck + web build clean; `migrate status` clean.
- ✅ **Z1 — Foundation** — new roles `director` + `manager` (+ demo logins director@/manager@quotezen.local,
  pw `demo`); `clients.tier` (A+/A/B); five Financial-Bumper settings (`min_gross_margin` 0.28,
  `walk_away_margin` 0.22, `lead_time_buffer_days` 3, `aud_usd_rate` 0.71, `human_in_the_loop` 1); and an
  `anomaly_rules` table seeded with 5 rules (key/label/enabled/severity/paramNum). Admin CRUD registered.
- ✅ **Z2 — RBAC wiring** — director/manager flow through the API `write` guards (+ /kb, /users/viewers) and
  web nav as internal staff (viewers stay read-only). `USER_ROLES` + web `Role` widened.
- ✅ **Z3 — Two-tier margin guardrail + lead-time buffer** — `changeStatus` gates finalisation by margin band:
  **≥28% ok · 22–28% needs an approver (admin/director/manager) · <22% needs director-level (admin/director)**,
  each override audited via `margin_guardrail`. `margin_floor` no longer gates (retained for the override
  *warning* + snapshots); `/price` surfaces `min_gross_margin` as the floor + `walkAwayMargin` (admin). The
  `lead_time_buffer_days` (+3) is added to every configured option's manufacturer lead time in the API layer
  (`calc/config.ts` stays pure). Updated the pre-existing below-floor tests to the two-tier behaviour.
- ✅ **Z4 — Configurable anomaly-rules engine** — `evaluateAnomalies(quote)` reads the enabled `anomaly_rules`
  (thresholds live from `paramNum`) and enforces the 5 rules in `validateQuote` (folded into counts +
  `canFinalise` + a new `anomalies[]`): nonstandard cabinet (block, cut-cabinet per the config engine's
  tolerance), discount>12% on A+ (warn), outdoor <2500nit (warn), air-freight + lead <5wk (block), custom
  engineering (warn, +$1590). `changeStatus` gates on `collectAllErrors` (anomaly blocks incl.) with approver
  override. Disabled rows ⇒ no findings. Web Validation card renders anomalies.
- ✅ **Z5 — Engine constraints admin panel** — `/admin/engine` (admin-only) matching the mockup: 6 Financial
  Bumpers with Edit (value + ACTIVE) + 5 Anomaly Rules with BLOCK/WARN badges + Configure (enabled/severity/
  param), all via the existing generic admin CRUD (settings + anomaly-rules). `aud_usd_rate` is managed here
  as the "assumption of record" (live USD→AUD conversion still uses the Currencies exchange rate).
- ✅ **Z6 — Client tiers as rule-bearing entities** — `client_tiers` table (A+/A/B: description, install
  standard, **preferred freight**, **default discount %**); `clients.tier` relates to it by name;
  `clients.rulesNote` (free-text per-client logic) + `clients.preferredFreight` (override). Rule resolution
  is now **global → tier → client**: `resolveDiscount` layers quote → client → **tier.defaultDiscountPct** →
  system default (new `'tier'` source); `/rules/client/:id/effective` reports the tier block + winning source
  + tier freight. Pixel pitch and mediaplayer-exclusion stay per-client. New `/admin/tiers` page (tier cards
  with client chips + editable per-client logic notes). `getQuote` loads `client.clientTier`.

**Interpretation applied:** walk-away (<22% margin) is **Director-approvable** (not an absolute block) — the
Director role exists precisely for that authority. `aud_usd_rate` is managed/displayed but not wired into live
FX conversion (that would change workbook-verified pricing) — flagged as a follow-up.

### Block 16 — light / dark / system theme toggle (persisted per-user in the DB)
Users can switch between **Light · Dark · System** at any time; the choice is stored on the user row and restored on
next login. The app was previously dark-only (hardcoded `:root` CSS variables). Typecheck + web build clean; new
`theme.test.ts` (5 tests, api); verified live in-browser (3-way cycle flips `data-theme`, persisted to the DB via a
fresh `GET /auth/me`; `system` resolves against the OS).
- ✅ **Schema** — `users.theme_preference` (TEXT, `@default("dark")`, migration `user_theme_preference`); existing
  users default to the original dark palette so nothing changes for them. Shared `THEMES = ['light','dark','system']`
  enum (the stored PREFERENCE — the value applied to the DOM is only light|dark) + `updateMeSchema` (Zod).
- ✅ **API** — the login response `user` now carries `themePreference` (the JWT stays minimal — id/email/role — so a
  theme change never mints a new token); `GET /auth/me` reads the fresh value from the DB; new self-service
  `PATCH /auth/me` (authenticated, any role) persists `{ themePreference }`. Invalid value → 422, no token → 401.
- ✅ **Web** — a pre-paint `<script>` in the root layout reads `localStorage['quotezen_theme']` and sets
  `<html data-theme>` before first paint (no flash of the wrong palette); a `system` (or unknown) value resolves
  against `prefers-color-scheme`, missing → dark (legacy default). `login()` seeds that key + applies the resolved
  theme. `lib/theme.ts` (`getStoredPref`/`resolveTheme`/`systemTheme`/`storePref`/`setThemePref`) applies instantly +
  fire-and-forget PATCHes the DB (failure is non-fatal — local preference holds). `components/ThemeToggle.tsx`
  (☀️/🌙/🖥️) **cycles** Light → Dark → System and, while on System, re-applies live when the OS scheme changes (a
  `matchMedia` listener); it sits in both the admin sidebar and the quotes header. `globals.css` gains a
  `[data-theme='light']` variable block; hardcoded on-accent text `#0f1115` → `var(--on-accent)` (near-black in dark,
  white in light) and the popover shadow → `var(--shadow)`, so both palettes read correctly. Accent stays the brand teal.

### Block 17 — admin discount-cap override: inline warning (not a hard stop) (web)
The quote-level discount cap (`discount_cap_pct`, default 12%) is unchanged server-side: a non-admin above the cap
is hard-stopped (403; the input also clamps), an admin may override with a manager note (audited `discount_guardrail`).
Per UX decision, an admin exceeding the cap is **not** stopped — instead a prominent **amber inline warning banner**
flags it (so it isn't accidental) and the server audits the override. `apps/web/app/quotes/[id]/page.tsx` `DetailsStep`:
when `isAdmin && overCap`, a warning renders under the discount fields ("⚠ This discount (N%) exceeds the 12% cap.
You can proceed as an admin, but the override will be recorded in the audit log (a manager note is required)"); Save is
NOT blocked and auto-save runs normally. (The earlier `window.confirm`/`capAck` gating was removed — a passive warning
per user preference.) The `>5%` manager-note requirement still gates save (separate rule, server-enforced 422) and the
warning mentions it. Non-admins remain hard-blocked. Web-only — no schema/API change; the server remains the
enforcement boundary.

### Block 18 — per-model recommendation priority (admin-set, secondary ranking key)
The LED config engine already ranked by **manufacturer priority** (`manufacturers.priority`, admin-editable, PRIMARY
key). Added an admin-settable **per-model priority** so admins can order preferred *models* within a manufacturer for
the recommended options. Both priority values are now admin-maintained in Reference data and drive the ranked configs
+ Good/Better/Best "Recommended" tier. 116 calc tests + full api suite green; typecheck + web build clean.
- ✅ **Schema** — `led_products.priority` (`Int @default(100)`, migration `led_product_priority`); default 100 =
  neutral, so existing catalogues rank exactly as before until an admin changes a value.
- ✅ **Config engine** (`packages/calc/src/config.ts`) — `ConfigProduct.modelPriority` + `ConfigOption.modelPriority`
  (`DEFAULT_MODEL_PRIORITY = 100`); the sort gains it as the **SECONDARY key**, right after `manufacturerPriority` and
  before best-fit: `1. manufacturerPriority 2. modelPriority 3. area-fit 4. exact>under>over …`. So manufacturer order
  wins first, then admin model order, then fit. Recommended tier = ranked[0], so it inherits both.
- ✅ **API** — `screens.ts` maps `modelPriority: p.priority` into the ConfigProduct (alongside manufacturer priority);
  admin registry exposes `priority` on `led-products` (editable + a list column). Prisma returns it by default (no
  include change).
- ✅ **Web** — the ranked configurations table gains a sortable **"Model pri."** column (`ConfigOption.modelPriority`).
- **Not changed:** Value/Premium tiers still rank by cost/sqm and pitch by design (different axes); only the
  best-fit/Recommended ordering honours the priorities.

### Block 19 — quote history: full rule capture in version snapshots + a rules viewer
Quote history already existed (Review step: **Change history** field-level audit, **Versions** immutable save-points,
**Compare versions** diff; rollback is history-preserving — a restore creates a NEW version, never overwrites; snapshots
are insert-only `quote_revisions.snapshot` JSON, unique per revision, `restoredFrom` lineage). Two gaps closed so a
version is a COMPLETE, tamper-proof record of the rules that produced it, and those rules are viewable.
- ✅ **Fuller rule capture (backend)** — `versioning.ts` `captureRuleSet(quote)` now freezes, alongside the existing
  markups/freight/addOns/rates/marginFloor: **margin bands** (`minGrossMargin`/`walkAwayMargin`), **discount policy**
  (`discountCapPct`/`discountNoteThresholdPct`), the **resolved quote discount** (`{pct,source,scope}` via
  `resolveDiscount`, as `/price` does), **clientTier** (`{name,preferredFreight,defaultDiscountPct}|null`), **all
  anomaly rules** (`[{key,label,enabled,severity,paramNum}]` — a later toggle can't rewrite history), **financial
  bumpers** (`{leadTimeBufferDays,audUsdRate,humanInTheLoop}`), and **manufacturerPriorities** (`[{name,priority}]`;
  per-product led_products priorities deliberately excluded — 177 rows, and the chosen screens are already in the
  snapshot tree). Reuses existing getters (no duplicated constants); defensive (missing setting → null, never throws);
  one `Promise.all`, no N+1. `SnapshotRuleSet` fully typed. `rollbackToVersion`/`diffVersions`/`listVersions`/
  `getVersionSnapshot` unchanged (diff now naturally surfaces the new `ruleSet.*` paths). `versioning-ruleset.test.ts`.
- ✅ **Version rules viewer (web)** — the Versions panel gains a **"View"** button per revision → modal (mirrors the
  preview-modal scrim/✕/Esc pattern) over `GET /quotes/:id/versions/:rev`. Shows a **Summary** (label, grand total,
  created/captured at, LED+LCD screen counts, resolved discount w/ source+scope) and **"Rules in force at this
  version"** — a generic renderer: scalar bands as %/values, object groups (markups/freight/add-ons/bumpers/rates/
  discount/clientTier) as key/value tables, and array groups (anomaly rules w/ block=red·warn=amber + enabled ✓/✗ +
  param; manufacturer priorities) as small tables. Tolerates pre-capture snapshots (missing keys skipped). Read-only.
- **Already met (no change):** (a) see history, (c) restore-as-active (history-preserving rollback), (d) immutable
  separate instance per state.

### Block 20 — Quotes dashboard: summary cards + Pending-approval tab + last-two-months default (web)
`apps/web/app/quotes/page.tsx` refinements (web-only; no API/schema change — the `/quotes` list already supports
from/to/clientId/q/archived filters):
- **Default date window = last two months** — `from` initialises to `isoMonthsAgo(2)` (to = open-ended). "Clear
  filters" resets to this window (clear the "Created from" field manually for all-time); `hasFilters` compares against
  the default.
- **Summary cards** — four clickable KPI cards above the tabs (Total/Archived · Drafts · Pending approval · Finished),
  counts derived from the current filtered set; clicking a card switches to that tab. Reuses `.totals`/`.stat` styling.
- **Pending-approval tab** — new `pending` tab + `PENDING_STATUSES = ['in_review','technical_review','commercial_review']`
  (the mid-review/approval states). `DRAFT_STATUSES` narrowed to `['draft']` (in_review moved to pending). Tabs order:
  All · Drafts · Pending approval · Finished · Archived.
- **Fetch keyed on the archived flag + filters (not the tab)** — the draft/pending/finished/all grouping is client-side
  (`tabStatuses`), so switching among non-archived tabs is instant (no refetch) and the summary stays stable. Raw
  `fetched` set drives both `rows` (tab-grouped) and `summary` via `useMemo`. Empty-state message is tab-aware
  (e.g. "No quotes pending approval." when other quotes exist in the window). Verified live in-browser.

**Block 20 follow-up — dashboard redesign (KPI cards + per-status pills + richer rows).** Reworked the quotes list into
a proper dashboard (inspired by a workshop mockup; real data only — no AI confidence/sentiment/time-saved):
- **KPI stat cards** (metrics, not filters): Open quotes (count) · Pipeline value (Σ grandTotal of open) · Awaiting
  approval (count) · Won value (Σ grandTotal won) — all over the current filter window, honest sums (dominant currency).
- **Per-status filter pills with live counts** — All · Draft · Pending approval · Approved · Issued · Won · Lost ·
  Archived (each maps to a status group in `GROUPS`; counts from `fetched`, client-side grouping so pill switches are
  instant; Archived refetches). Replaces the earlier 4-tab set.
- **Richer table** — Brief (bold job ref link + client · relative time) · Stage (per-status coloured badge) · **Tier**
  (client tier A+/A/B) · **Value** (grandTotal + **Go-live** = requestedShippingDate, else "Go-live TBC") · actions.
  Backend: `listQuotes` include gains `client.clientTier` (requestedShippingDate was already a returned scalar) — the
  only API change. Last-two-months default + Clear-filters + tab-aware empty state retained. Verified live in-browser.

### Block 21 — Client + Location mandatory on the Details step (web)
`apps/web/app/quotes/[id]/page.tsx` `DetailsStep`: Client and Location are now **required** — the labels show a `*`,
`detailsIncomplete = !clientId || !locationId` gates the Create/Save button (disabled) and the debounced auto-save,
and a red hint states what's missing ("Client and location are required." / "Client is required." / "Location is
required."). Applies in both create and edit mode. Enforced client-side only (the server create/update schemas stay
lenient so existing client-less draft quotes and the API test suite are unaffected — a strict server requirement would
422 the many minimal-payload create tests). Verified live (button disabled + hint until both picked, enabled after).

### Block AA1 — site/context intake fields (workshop intake gap, Group A)
From the merged intake/rules workbook (`SEEN_LED_LCD_Merged`). Captured the missing site-context questions.
Migration `aa1_site_context`: `quotes` gains `end_customer`, `airside_landside`, `sun_exposure`, `wall_substrate`,
`power_data_available`, `controller_location`, `window_facing`; `quote_led_screens` + `quote_lcd_screens` gain
`recess_depth_mm`. Shared `createQuoteSchema`/`updateQuoteSchema` + `ledScreenSchema`/`lcdScreenSchema` extended
(optional/nullish); `createQuote`/`updateQuote` + all screen add/edit/duplicate paths persist them; PM handoff
(`outputs.ts`) emits a defensive "Site context" section + per-screen recess depth. Web `DetailsStep` gains a Site-context
sub-block (text + SearchSelect enums + window-facing checkbox); LED & LCD forms gain a Recess depth (mm) input.
Descriptive only — no pricing change. 146 api tests green (+3 `aa1-site-context.test.ts`); typecheck + web build clean.

### Block AA2 — LED selection rules (workshop rules, Group B)
Migration `aa2_led_rules`: `led_products`/`controllers`/`frames` gain `compatibility_group`; `clients` gains
`allowed_ratios` (CSV); `quote_led_screens` gains `content_ratio`/`content_supplier`/`flatness_required`. Seed adds a
`6:1` ticker ratio (+ disjoint bands so it resolves) and an example `"HX"` compatibility group. Rules (all through the
existing `validateScreen`/`validate.ts` aggregate + Review card; error-severity gate finalisation):
- **Allowed ratios per client** — `ConfigRequest.allowedRatios` filters offered configs (empty-with-reasons if none fit,
  like the environment filter); `RATIO_NOT_ALLOWED` (warn) on a stored screen outside the set.
- **Conflict matrix** — `CONTROLLER_SCREEN_MISMATCH` / `BRACKET_SCREEN_MISMATCH` (error) when a chosen controller/frame
  compatibility group differs from the screen product's (no-op when either side null — never a false error).
- **Fixed-pitch-per-customer** — `PITCH_NOT_CLIENT_PREFERRED` (warn) vs `clients.preferredPitchMm`.
- **Content-ratio match** — `CONTENT_RATIO_MISMATCH` (warn) when `content_ratio` ≠ achieved ratio; content supplier +
  flatness captured (LED form + PM handoff). Admin registry exposes the new catalog/client fields.
150 api tests green (+4 `aa2-led-rules.test.ts`); calc 116 (+3); typecheck + web build clean.

### Block AA3a — LCD constraint rules (workshop rules, Group C part 1)
Migration `aa3a_lcd_rules`: `display_catalog` gains `brand`, `built_in_android`, `depth_mm`, `min_size_in`,
`max_size_in`, `portrait_capable`; `quote_lcd_screens` gains `requires_android`, `max_depth_mm`, `needs_pc`,
`needs_hard_drive`. Rules via the existing `validateLcdScreen`/`validate.ts` aggregate (all warning-severity, null-safe):
`LCD_DEPTH_EXCEEDED` (site max depth < display depth), `LCD_ANDROID_REQUIRED` (requires-Android vs non-Android
display), `LCD_BRACKET_SUBRANGE` (panel size outside the bracket's size range / portrait on a non-portrait bracket),
`LCD_PC_DEPENDENCY` (needs-PC / needs-hard-drive flagged). LcdStep "Site requirements" block + admin `display-catalog`
fields + PM handoff updated. 156 api tests green (+6 `aa3a-lcd-rules.test.ts`); typecheck + web build clean.
