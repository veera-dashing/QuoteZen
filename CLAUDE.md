# QuoteZen — Project Guide

Commercial **quoting engine** for Seen Technology (digital-signage / AV). Builds multi-component client proposals combining hardware catalogs, custom manufacturing, regional labour rates, logistics, and recurring software licences — replacing a complex Excel workbook (`2026-XXX Quote Base V1.3`) with a relational, audited, web-based wizard.

> **Source of truth for the domain:** the original Excel workbook. Sheets → our model:
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

**Dependency direction:** `shared` ← `calc` ← (`api`, `web`); `db` ← (`api`, seed).
`calc` is pure (no DB, no IO) — testable in isolation, safe to run in the browser.

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

## Run the whole thing

```bash
pnpm --filter @quotezen/api dev    # API on :4000 (loads root .env)
pnpm --filter @quotezen/web dev    # web on :3000  → /quotes
```

## Demo logins (password `demo`)

- `admin@quotezen.local` — admin (full access)
- `sales@quotezen.local` — sales (write, own quotes only)
- `viewer@quotezen.local` — viewer (read-only)
- `manager@quotezen.local` — manager (can approve thin-band margin quotes)
- `director@quotezen.local` — director (can approve below-walk-away-floor quotes)

## Local Postgres for dev/tests

```bash
docker run -d --name quotezen-pg \
  -e POSTGRES_USER=quotezen -e POSTGRES_PASSWORD=quotezen \
  -e POSTGRES_DB=quotezen -p 5433:5432 postgres:16-alpine
# packages/db/.env → DATABASE_URL=postgresql://quotezen:quotezen@localhost:5433/quotezen
```

## Per-folder documentation

Each workspace has its own CLAUDE.md with folder-specific conventions and history:

| Folder | CLAUDE.md | Contents |
|---|---|---|
| `apps/api/` | [CLAUDE.md](apps/api/CLAUDE.md) | Fastify layering, RBAC, guardrails, test patterns, DB corruption fix, RDS migration workflow, full block history |
| `apps/web/` | [CLAUDE.md](apps/web/CLAUDE.md) | Next.js App Router, wizard steps, SearchSelect, ThemeToggle, role-aware UI, dashboard |
| `packages/calc/` | [CLAUDE.md](packages/calc/CLAUDE.md) | Pure pricing functions, workbook constants, PricingConfig, test approach |
| `packages/db/` | [CLAUDE.md](packages/db/CLAUDE.md) | 58-table schema, modelling decisions, RDS migration workflow, seed, settings |
| `packages/shared/` | [CLAUDE.md](packages/shared/CLAUDE.md) | Money helpers (Decimal.js), Zod schemas, enums |

## Current status

**233 tests green** (9 shared + 110 calc + 119 api — last full run). Typecheck + web build clean. `prisma migrate status` clean.

Completed build blocks: Scaffold → packages/shared → packages/calc → packages/db → apps/api → Full catalog import → Generic CRUD API → apps/web → Quote wizard → LED install/labour → PDF export → Per-user scoping → Config engine → Validation engine → Pricing add-ons → Quote outputs → Versioning → Margin guardrail → RBAC → Concurrency → Client overrides → KB capture → Audit viewer → Blocks 6–14 (UI/UX) → Block 15 Z-series governance → Block 16 themes → Blocks 17–21 → Blocks AA1–AA7 (intake + engine alerts).

**Still deferred by decision (needs infra/AI):** Google OAuth, Zoho sync + AI doc extraction, Knowledge Engine (vector similarity), Learning Engine, Zoho estimate push, real S3 + AV scanning (prototype uses local disk), full Terraform/Docker/CD.
