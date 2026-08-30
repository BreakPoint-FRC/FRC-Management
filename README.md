# BreakPoint

FRC team management app: accounts and role-based access, departments, seasons,
meeting roll call & reports, group/cross-group task management with a change
log and Gantt view, and a sponsorship/finance tracker.

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

Then open http://localhost:3000, which redirects to the sign-in page.

Every seeded account uses the password **`Breakpoint2026!`**. Sign in as
`ada@breakpoint.test` for a `SYSTEM_ADMIN`, `kerem@breakpoint.test` for a
department lead, or `emre@breakpoint.test` for a plain member. The three see
noticeably different things — the admin gets eleven nav items, the lead six, the
member four — which is the quickest way to check the permission model is
working. The same holds inside a page: a member can add and move a task in
their own department but has no Sil button, and the server refuses the request
even if they forge one. The overview page puts each account's roles, departments and resolved
permission matrix on one screen for the same reason.

Accounts that predate authentication carry an unusable password placeholder and
must be given a real one (`POST /accounts/:id/password`) before they can sign
in.

Copy `.env` first. Install warns rather than fails without it, but everything
that talks to the database needs `DATABASE_URL` set, and the API refuses to
start without `JWT_SECRET`. Generate a real one per environment with
`openssl rand -hex 32`.

- API: http://localhost:4000 (`API_PORT`)
- Web: http://localhost:3000 (`WEB_PORT`)

The two ports are separate variables on purpose. A single shared `.env` means a
bare `PORT` is read by *both* apps, and `next dev` would bind the API's port —
on Windows both servers bind successfully and requests are answered by whichever
one wins the race, which is a genuinely confusing thing to debug.

## Authentication

Two tokens. The access token is a short-lived JWT the client sends in an
`Authorization` header; the refresh token is a long-lived opaque value in an
httpOnly cookie that JavaScript cannot read.

```
POST /auth/login     { email, password }  -> { accessToken } + refresh cookie
POST /auth/refresh   (cookie)             -> a new accessToken, and a new cookie
POST /auth/logout    (cookie)             -> 204
GET  /auth/me                             -> account, roles, groups, permissions
POST /auth/password  { currentPassword, newPassword }
```

The access token is deliberately not stored in `localStorage` — a token that
survives a tab close is what turns an XSS bug into a stolen session. It lives in
memory, and `apps/web/lib/api-client.ts` silently refreshes once on a 401 and
replays the request.

Refresh tokens rotate: using one revokes it and issues another. Presenting a
token that has already been used revokes **every** session for that account,
because there is no way to tell the thief from the owner. That makes a second
concurrent refresh indistinguishable from theft, so the client funnels all of
them — the session restore on boot and every 401 retry — through one shared
in-flight call: a page firing five requests at once rotates the token once.

Passwords are hashed with argon2id. Who may do what is decided entirely on the
server — see [docs/authorization.md](docs/authorization.md).

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

Cached API responses are split by account: the worker reads the account id out
of the request's `Authorization` header and stores the response in
`breakpoint-api-v2-<accountId>`. That is not tidiness. The Cache API keys
entries by URL alone, so a single cache would hand the next person to sign in
on a shared pit laptop the previous one's data whenever the network is slow
enough to hit the 5s API timeout. Separating the caches by name means no
timing — signing in does not have to win a race against a cleanup message —
can produce that. The id is only a partition key and is never verified here;
the token itself never becomes part of a cache name.

The app also drops every account's API cache whenever the signed-in account
changes: signing out, signing in, a refresh the server refused, a session
revoked from another device. All of those pass through `setAccessToken`, which
posts `{ type: "purge" }` to the worker; a token rotating for the same account
is not a change, so ordinary refreshes leave the offline reads alone. The shell
and navigation caches survive a purge, because the offline page, icons and page
shells belong to nobody: pages render on the client and fetch their data from
the API.

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
- [docs/authorization.md](docs/authorization.md) — who may do what, and how it is checked
- [docs/roles.md](docs/roles.md) — the role model and the rules behind it
- [docs/migrations.md](docs/migrations.md) — database change rules
- [docs/documentation.md](docs/documentation.md) — what to document, and where
- [docs/product/](docs/product/) — scope and roadmap

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before pushing;
that is exactly what CI runs.
