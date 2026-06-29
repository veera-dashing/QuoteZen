# QuoteZen

Commercial quoting engine for Seen Technology (digital-signage / AV). Replaces the
`Quote Base` Excel workbook with a relational, audited, web-based quote wizard.

## Quick start

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL
pnpm db:generate                # Prisma client
pnpm db:migrate                 # create schema
pnpm db:seed                    # load reference data from the xlsx
pnpm dev                        # api + web
```

## Workspaces

| Package | Purpose |
|---|---|
| `packages/shared` | shared types, Zod schemas, money helpers |
| `packages/calc` | pure pricing engine (unit-tested) |
| `packages/db` | Prisma schema + migrations + seed |
| `apps/api` | Fastify REST API |
| `apps/web` | Next.js 16 quote wizard |

## Testing

```bash
pnpm test                       # all packages
pnpm --filter @quotezen/calc test
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture, the 58-table data model, and conventions.
