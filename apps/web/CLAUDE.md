# QuoteZen Web — `apps/web`

Next.js 16 App Router. The quote wizard UI + admin data browser.

## Structure

```
app/
  layout.tsx          root layout: pre-paint theme script, sidebar, header
  quotes/
    page.tsx          quotes dashboard (list + KPI cards + status filters)
    [id]/page.tsx     quote wizard (create + edit, all steps)
  admin/
    [resource]/       generic CRUD driven by /admin/_meta
    users/            admin user management
    audit/            cross-quote audit feed
    engine/           financial bumpers + anomaly rules admin panel (Z5)
    tiers/            client tier cards (Z6)
    margins/          13 commercial multipliers editor
components/
  SearchSelect.tsx    searchable combobox (used everywhere instead of native <select>)
  ThemeToggle.tsx     ☀️/🌙/🖥 Light → Dark → System cycle
lib/
  theme.ts            getStoredPref / resolveTheme / storePref / setThemePref
  auth.ts             getRole(), session helpers
```

## Quote wizard

Route: `/quotes/[id]` (or `/quotes/new` → redirects to same route with `id === 'new'`).

### Steps

`STEPS = Details · Select Screens · Licences · Review`

**Details** — job ref, client (required), location (required), currency, site-context fields, commercial intake fields, dependency fields, discount override %, discount scope. Optimistic-lock PATCH (`expectedVersion`). A 409 conflict banner + "Reload latest" button handles stale saves. Auto-save (debounced, pauses on conflict). Create mode: "Create & continue" → POST /quotes → redirect to `?step=1` (Select Screens).

**Select Screens** — LED/LCD type toggle + combined screen list. LED add form has two parts:
1. Screen selection (viewing distance, environment, GOB) → ranked config table + G/B/B tiers
2. Options & services (trim/frame/GOB/install/freight/warranty/back-cover/notes) — expandable per-screen editor (saved via PATCH `updateLedScreen`)

LCD form: display picker + 6 sections (Display · Mediaplayer & Peripherals · Bracket & Shroud · Configuration/Installation · Seen Labour · Location Fees) + analysis block.

Each screen row has: ✎ Edit (re-opens add form pre-filled), 📊 Cost breakdown (expandable inline panel with per-line discount editing), ▲/▼/Qty/Duplicate controls.

**Licences** — screen-type + volume-tier pickers (SearchSelect).

**Review** — Outputs (PDF, BOM, solution summary, PM handoff), Validation card, Itemised price, Versions panel, Comparison (diff), Proposal text editor, Risks register, Documents + re-run, Approval card (two-stage reviews).

### Quote summary sidebar

Sticky right-hand aside visible in edit mode. Collapsible — state persisted in `localStorage['quotezen_summary_open']`. When hidden, a fixed floating side-tab (`.summary-tab`) restores it without consuming layout.

Sections: Quote summary (client/site/job ref) · Stats (lines/units/docs) · Screens · Discount (cap pill) · Completeness (progress bar + checklist) · Totals (grand + recurring).

Stage-aware accent-border emphasis: Details → Completeness+Discount; Select Screens → Screens+Stats; Licences → Totals; Review → Totals+Completeness.

## Role-aware UI

`getRole()` reads from the login response (falls back to JWT decode). Navigation filtered by role:
- Admin: everything
- Sales/Manager/Director: Quotes + Knowledge base + Reference data (no Users/Audit)
- Viewer: `/quotes` only, read-only

**Cost fields** are admin-only (BR-081) — masked with a note for non-admins. **Margin + floor** in `/price` are admin-only. **Override guardrail**: admin sees an amber warning banner (not a block) when exceeding the discount cap; non-admins are hard-blocked (input clamped to cap).

## SearchSelect component

`components/SearchSelect.tsx` — type-to-filter popover, click-away/Esc to close. Used for:
- Client/location/currency pickers
- LED product picker (~177 rows)
- Display catalog picker (~464 rows)
- Admin form enums
- All wizard lookups (frame/trim/install/freight/warranty/service-hours/access/GOB/coating/etc.)

Replace any native `<select>` that has more than ~5 options with SearchSelect.

## Theme system

Preference stored in `localStorage['quotezen_theme']` (values: `light` | `dark` | `system`) and in the DB via `PATCH /auth/me`. Three sources in priority order: stored pref → system → `dark` (legacy default).

**No flash of wrong palette:** root `layout.tsx` has an inline `<script>` that reads localStorage and sets `<html data-theme>` before first paint.

`lib/theme.ts` exports `setThemePref(pref)` — applies instantly + fire-and-forget PATCHes the DB. `ThemeToggle` cycles Light → Dark → System and, while on System, re-applies live when OS scheme changes (matchMedia listener).

CSS: `globals.css` has `[data-theme='dark']` (default) + `[data-theme='light']` variable blocks. Accent stays brand teal. `--on-accent` (near-black in dark, white in light), `--shadow` for popovers.

## Quotes dashboard (`quotes/page.tsx`)

- **Default window:** last two months (`isoMonthsAgo(2)` for `from`, open-ended `to`)
- **KPI stat cards:** Open quotes count · Pipeline value · Awaiting approval · Won value (honest sums over filter window)
- **Per-status filter pills with live counts:** All · Draft · Pending approval · Approved · Issued · Won · Lost · Archived (client-side grouping, instant; Archived refetches)
- **Richer table:** Brief (job ref link + client + relative time) · Stage (coloured badge) · Tier (client tier A+/A/B) · Value (grand total + go-live date or "TBC")

## Key patterns

**Optimistic concurrency (Details step):** save sends `expectedVersion: quote.lockVersion`; 409 → conflict banner + Reload button; lock token `v{n}` shown in card header. Auto-save (debounced) suspends while unmet discount guardrail conditions exist.

**Client/location required:** `detailsIncomplete = !clientId || !locationId` gates Create/Save button; red hint text. Client-side only enforcement (server stays lenient for existing quotes and test suite).

**Viewer read-only:** `DetailsStep`, cost breakdown, proposal text editor, risks register all branch on `isViewer`.

**Screen labels:** `ledScreenLabel` / `lcdScreenLabel` — "Manufacturer - Model / product name" when unnamed; user-set name wins.

## Environment variables

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Set in `apps/web/.env.local`.
