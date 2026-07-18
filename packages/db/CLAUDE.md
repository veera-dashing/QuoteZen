# QuoteZen DB — `packages/db`

Prisma schema (58 tables), migrations, and the xlsx reference-data seed.

## Schema overview

Three layers:

### 1. Auth & audit (4 tables)
`roles`, `users`, `quote_audit_log` (field-level who/when/old→new), `quote_revisions` (named save-points with immutable `snapshot` JSON).

### 2. Reference / catalog (~40 tables)
Admins CRUD here; quotes reference by FK. Includes:
- Currency: `currencies`, `exchange_rates`, `settings`, `seafreight_rates`
- Freight/location: `freight_options`, `locations`, `freight_overrides`
- LED domain: `led_products` (~230 rows), `led_commentary`, `controllers`, `led_peripherals`, `gob_options`, `trim_options`, `hanging_bar_options`, `frames`, `engineering_options`, `install_methods`, `access_equipment`, `warranty_options`, `service_hours_options`, `screen_ratios`, `coating_options`
- Hardware: `mediaplayers`, `peripherals`
- Catalogs: `display_catalog` (543 rows, `category` discriminator), `import_catalog`, `manufactured_products`, `manufactured_components`/`manufactured_bom`
- Labour: `installer_rates`
- Licence/support: `licence_components`, `hardware_support_components`, `international_support_rates`, `international_install_rates`, `international_vat`
- Software: `software_activities`, `audio_products`, `music_services`, `hypervsn_products`
- Clients: `clients`, `client_tiers`, `manufacturers`
- Governance: `anomaly_rules`

### 3. Quote transactional (~14 tables)
`quotes`, `quote_led_screens`, `quote_led_components`, `quote_led_cost_breakdown`, `quote_lcd_screens`, `quote_lcd_items`, `quote_mediaplayers`, `quote_peripherals`, `quote_manufactured_items`, `quote_audio_items`, `quote_music_items`, `quote_hypervsn_items`, `quote_software_items`, `quote_licences`, `quote_terms`, `quote_overrides`, `quote_risks`, `quote_reviews`, `quote_documents`, `quote_viewers`, `kb_entries`, `admin_audit_log`

## Key modelling decisions

- **Catalog vs quote separation:** products live only in the catalog; quotes reference by FK. Spec/price columns on `quote_*` rows are computed outputs + a point-in-time price snapshot.
- **Dependent components are a flexible FK'd list** (`quote_led_components`, `quote_lcd_items`) — a screen can carry N components; new component types need no schema change.
- **PI (Project Information)** is per-screen (`quote_led_screens` / `quote_lcd_screens`); quote-wide fields (job ref, ship date, cost rollup) sit on `quotes`.
- **Money:** Postgres `NUMERIC` / Prisma `Decimal` — never float. Use `packages/shared` money helpers.
- **`deprecated` flag on 23 catalog models:** admin DELETE catches P2003 (FK violation) → deprecates instead of hard-deleting. `?activeOnly=true` + config engine + wizard exclude deprecated from new quotes while existing quotes retain their rows.
- **`onDelete: Restrict`** on `quote_*→catalog` FKs — prevents silent snapshot-FK nulling.
- **`quote_revisions.snapshot`** — insert-only JSON (immutable historical artifact). `restoredFrom` lineage for rollback history.
- **`quotes.lock_version`** — optimistic concurrency token; bumped on every quote mutation.

## Migration workflow (RDS — no shadow DB)

The RDS user cannot create a shadow DB, so `prisma migrate dev` **always fails**. Correct workflow:

```bash
# 1. Edit schema.prisma with your changes

# 2. Generate the SQL diff
pnpm --filter @quotezen/db exec prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/$(date +%Y%m%d%H%M%S)_<migration_name>/migration.sql

# 3. Apply to the DB
pnpm --filter @quotezen/db exec prisma migrate deploy

# 4. Regenerate Prisma client
pnpm db:generate

# 5. Verify status is clean
pnpm --filter @quotezen/db exec prisma migrate status
```

**Enum value additions** require a separate `ALTER TYPE … ADD VALUE` migration — enum values don't surface in a column diff from Prisma. Create two migration files (add column changes, then add enum value) or use a raw SQL migration.

## Seed

`prisma/seed.ts` / `import-catalogs.ts` — loads reference data from xlsx + JSON:
- ~230 LED products
- ~464 display catalog rows
- ~68 Philips Q-Line rows
- Manufacturers (LEDFul p1/45d, ZonePro p2/60d, Muxwave p3/60d)
- Client tiers (A+/A/B with defaults)
- Anomaly rules (5 seeded)
- Financial bumper settings (`min_gross_margin 0.28`, `walk_away_margin 0.22`, `lead_time_buffer_days 3`, `aud_usd_rate 0.71`, `human_in_the_loop 1`)
- Discount policy settings (`discount_cap_pct 0.12`, `discount_note_threshold_pct 0.05`)
- Roles + demo users (admin/sales/viewer/manager/director, password `demo`)

Run seed:
```bash
pnpm db:seed
```

## settings table

Key-value store for system configuration. Values are stored as TEXT (including numeric ones like `min_gross_margin`). Services parse with `Number(value)` when needed. The `value_text` column handles non-numeric settings.

**Critical settings that affect guardrails:**
- `min_gross_margin` — canonical: `0.28`
- `walk_away_margin` — canonical: `0.22`
- `discount_cap_pct` — canonical: `0.12`
- `discount_note_threshold_pct` — canonical: `0.05`

If integration tests are failing with unexpected 403/422 errors, these settings may be corrupted by a crashed test run. Check and reset via a direct Prisma query.

## Local Postgres

```bash
docker run -d --name quotezen-pg \
  -e POSTGRES_USER=quotezen \
  -e POSTGRES_PASSWORD=quotezen \
  -e POSTGRES_DB=quotezen \
  -p 5433:5432 postgres:16-alpine
```

`.env` in `packages/db/`:
```
DATABASE_URL=postgresql://quotezen:quotezen@localhost:5433/quotezen
```
