# BreakPoint

FRC team management app: meeting roll call & reports, group/cross-group task
management, and a sponsorship/finance tracker.

## Layout

```
apps/web        Next.js (App Router) — the PWA
apps/api        Fastify (TypeScript) — REST API
packages/db     Prisma schema, migrations, client — PostgreSQL
packages/types  shared zod schemas/types used by web and api
packages/config shared tsconfig/eslint base config
docs/           migration + documentation rules, product scope
```

`packages/*` are compiled to `dist/` and consumed as built packages, so
`apps/*` never import raw `.ts` from across the workspace.

## Getting started

```bash
cp .env.example .env           # single env file, shared by all workspaces
pnpm install                   # also runs `prisma generate` via db postinstall
docker compose up -d           # starts local Postgres
pnpm --filter @breakpoint/db db:migrate
pnpm --filter @breakpoint/db db:seed   # sample data, so the pages aren't empty
pnpm dev                       # builds packages, then runs api + web
```

Copy `.env` first. Install warns rather than fails without it, but everything
that talks to the database needs `DATABASE_URL` set.

- API: http://localhost:4000
- Web: http://localhost:3000

## PWA

The web app is installable and supports **offline reads**: pages and API `GET`
responses you have already loaded stay available without a connection. Writes
still require the network.

- `apps/web/app/manifest.ts` — web app manifest (icons, theme, display mode)
- `apps/web/public/sw.js` — service worker; API reads are network-first with a
  5s timeout and cache fallback, so saturated venue wifi falls back to cache
  instead of hanging
- `apps/web/public/offline.html` — shown only for a page never visited before
- `apps/web/scripts/generate-icons.mjs` — regenerates `public/icons/` (no image
  dependencies). Run `node scripts/generate-icons.mjs` from `apps/web` after
  changing the colours, or just replace the PNGs with your own.

The service worker registers in production builds only — in dev it would serve
stale chunks and fight hot reload. Because `NEXT_PUBLIC_API_URL` is baked in at
build time, `next build` loads the root `.env`; set that variable for the
deployed API origin or offline reads will cache nothing.

## Scripts

| Command | Effect |
| --- | --- |
| `pnpm dev` | Build `packages/*`, then run api + web in watch mode |
| `pnpm dev:api` | Build `packages/*`, then run only the API in watch mode |
| `pnpm dev:web` | Build `packages/*`, then run only the web app in watch mode |
| `pnpm build` | Build every workspace in dependency order |
| `pnpm test` | Run vitest suites |
| `pnpm lint` | Lint every workspace |
| `pnpm typecheck` | Type-check every workspace without emitting |
| `pnpm --filter @breakpoint/db db:migrate` | Create/apply a migration (local only) |
| `pnpm --filter @breakpoint/db db:deploy` | Apply pending migrations (CI/production) |
| `pnpm --filter @breakpoint/db db:seed` | Load idempotent sample data |
| `pnpm --filter @breakpoint/db db:studio` | Open Prisma Studio |

Two things to know about the single-app scripts. `pnpm dev` also runs each
package's own `tsc --watch`, so edits to `packages/*` rebuild live; `dev:api`
and `dev:web` build the packages **once** at startup, so use `pnpm dev` if you
are editing `packages/db` or `packages/types` at the same time. And the web
app's pages read from the API, so `dev:web` on its own gives you a UI with
failing fetches unless the API is running in another terminal.

Both scripts build `packages/*` first on purpose. `pnpm --filter
@breakpoint/api dev` on its own skips that step, and since `dist/` is
gitignored and install only runs `prisma generate`, it fails with a
module-not-found error on a freshly cloned repo.

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) — branches, commits, code layout, PR checklist
- [docs/migrations.md](docs/migrations.md) — database change rules
- [docs/documentation.md](docs/documentation.md) — what to document, and where
- [docs/product/](docs/product/) — scope and roadmap

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before pushing;
that is exactly what CI runs.
