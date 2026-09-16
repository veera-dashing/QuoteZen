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

**Details** — job ref, client (required, with an inline "+ New client" row in the picker), location (required), currency, site-context fields, commercial intake fields, dependency fields. **No discount field** — it is set in the Review step; the sidebar's Discount section shows the effective rate at every stage. Optimistic-lock PATCH (`expectedVersion`). A 409 conflict banner + "Reload latest" button handles stale saves. Auto-save (debounced, pauses on conflict). Create mode: "Create & continue" → POST /quotes → redirect to `?step=1` (Select Screens).

**Select Screens** — LED/LCD type toggle + combined screen list. LED add form has two parts:
1. Screen selection (viewing distance, environment, GOB) → ranked config table + G/B/B tiers
2. Options & services (trim/frame/GOB/install/freight/warranty/back-cover/notes) — expandable per-screen editor (saved via PATCH `updateLedScreen`)

LCD form: display picker + 6 sections (Display · Mediaplayer & Peripherals · Bracket & Shroud · Configuration/Installation · Seen Labour · Location Fees) + analysis block.

Each screen row has: ✎ Edit (re-opens add form pre-filled), 📊 Cost breakdown (expandable inline panel with per-line discount editing), ▲/▼/Qty/Duplicate controls.

**Licences** — screen-type + volume-tier pickers (SearchSelect).

**Review** — Outputs (PDF, BOM, solution summary, PM handoff), Validation card, **Discount override** (pct + scope + manager note + cap guardrail; sits directly under the totals), Itemised price, Versions panel, Comparison (diff), Proposal text editor, Risks register, Documents + re-run, Approval card (two-stage reviews).

### Quote summary sidebar

Sticky right-hand aside visible in edit mode. Collapsible — state persisted in `localStorage['quotezen_summary_open']`. When hidden, a fixed floating side-tab (`.summary-tab`) restores it without consuming layout.

Sections: Quote summary (client/site/job ref) · Stats (lines/units/docs) · Screens · Discount (cap pill) · Completeness (progress bar + checklist) · Totals (grand + recurring).

Stage-aware accent-border emphasis: Details → Completeness; Select Screens → Screens+Stats; Licences → Totals; Review → Totals+Discount (the emphasis follows the discount control, which lives in Review).

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
- **Richer table:** Brief (job ref link + client + relative time) · Stage (coloured badge) · Tier (client tier A+/A/B) · Value (grand total + install start date or "TBC")

## Key patterns

**Optimistic concurrency:** saves send `expectedVersion: quote.lockVersion`; 409 → conflict banner + Reload button; lock token `v{n}` shown in the Details card header. Used by the Details auto-save (debounced) and by the Review step's Apply discount, which reloads and asks the user to re-apply on a conflict.

**Discount is set at the end (Review), not in Details.** Discounting before any screens exist meant conceding margin against a zero total. `DetailsStep` shows no discount field at all (writer form and viewer read-only panel alike), holds no discount state, and does **not** send `discountPct`/`discountNote`/`discountScope` in its PATCH — so a Details auto-save can never overwrite a discount applied later. The cap/note guardrail moved with the control.

**The API gates the discount only when a PATCH touches it.** `updateQuote` evaluates `enforceDiscountGuardrail` only when `discountPct` or `discountNote` is in the payload — otherwise an admin-approved above-cap discount would 403 every later non-admin edit of unrelated fields, and write a spurious `discount_guardrail` audit row on every unrelated admin save. Changing the note alone still gates.

**Part-finished work always saves.** Only a missing **job reference** blocks a Details save (it is the one NOT NULL / unique column). `detailsIncomplete = !clientId || !locationId` drives an **advisory hint only** — never a disabled button and never a suspended auto-save — so a user waiting on an address doesn't lose the twenty other fields they filled in. Client/location are enforced where they matter: at finalisation, in `changeStatus`.

> Screens are the exception: an LED screen still needs product + width + height to add, and an LCD screen needs at least one line, because a screen is **priced on insert** — there is no draft-screen concept in the schema.

**Viewer read-only:** `DetailsStep`, cost breakdown, proposal text editor, risks register all branch on `isViewer`.

**Screen labels:** `ledScreenLabel` / `lcdScreenLabel` — "Manufacturer - Model / product name" when unnamed; user-set name wins.

## Environment variables

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Set in `apps/web/.env.local`.
