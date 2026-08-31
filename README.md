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
pnpm --filter @breakpoint/db db:bootstrap  # the platform system admin
pnpm dev                       # builds packages, then runs api + web
```

Then open http://localhost:3000, which redirects to the sign-in page.

`db:bootstrap` reads `SYSTEM_ADMIN_EMAIL` and `SYSTEM_ADMIN_PASSWORD` from
`.env` and creates the **platform** administrator: the account that opens teams
and creates the administrator who runs each one. It belongs to no team, which is
the point of it — see [docs/teams.md](docs/teams.md).

Every seeded account uses the password **`Breakpoint2026!`**. Sign in as
`ada@breakpoint.test` for a `TEAM_ADMIN`, `kerem@breakpoint.test` for a
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
`Authorization` header; the refresh token is an opaque value that buys the next
access token. Both are returned in the response body and both are held only in
memory.

```
POST /auth/login     { email, password }  -> { accessToken, refreshToken }
POST /auth/refresh   { refreshToken }     -> a new accessToken and a new refreshToken
POST /auth/logout    { refreshToken }     -> 204
GET  /auth/me                             -> account, roles, groups, permissions
POST /auth/password  { currentPassword, newPassword }
```

Both tokens live in memory in `apps/web/lib/api-client.ts` and nothing about a
session is written to the device — no cookie, no `localStorage`, no cache. A
token that survives a tab close is what turns an XSS bug into a stolen session,
and a laptop left in the pit is not a trusted place to leave one either. The
client silently refreshes once on a 401 and replays the request, so a session
lasts as long as the tab does.

The cost is a sign-in on every page load: a reload starts a fresh module with
no tokens in it, so there is nothing to restore and `/auth/refresh` is not even
called. That is the trade this app makes on purpose, and it is paid once per
visit rather than every fifteen minutes.

Refresh tokens rotate: using one revokes it and issues another. Presenting a
token that has already been used revokes **every** session for that account,
because there is no way to tell the thief from the owner. That makes a second
concurrent refresh indistinguishable from theft, so the client funnels every
401 retry through one shared in-flight call: a page firing five requests at
once rotates the token once.

Passwords are hashed with argon2id. Who may do what is decided entirely on the
server — see [docs/authorization.md](docs/authorization.md).

An account created by an administrator gets a generated password, returned once
by the call that made it and stored nowhere. Until it is changed, the API refuses
every route but `/auth/me`, `/auth/password` and `/auth/logout`: a temporary
password is a way in, not a credential.

One database holds many teams, and a record belonging to another team answers
404 rather than 403 — a 403 would confirm the id exists.

## PWA

The web app is installable and runs standalone from a home screen, but it is
**online only**. There is no offline mode, no service worker and no cached data:
every screen is fetched when you open it, and losing the connection shows
"Internet baglantisi yok" rather than stale numbers.

- `apps/web/app/manifest.ts` — web app manifest (icons, theme, display mode)
- `apps/web/scripts/generate-icons.mjs` — regenerates `public/icons/` (no image
  dependencies). Run `node scripts/generate-icons.mjs` from `apps/web` after
  changing the colours, or just replace the PNGs with your own.

Storing nothing is the decision here, not an omission. This app holds a team's
finances and personal details, and the laptop it runs on during a competition is
shared, borrowed and left unattended; anything cached on it outlives the session
that fetched it. Offline reads were built once and removed for exactly that
reason — if you are tempted to add a service worker back, that is what you would
be trading away. The same reasoning is why both auth tokens live in memory.

Because `NEXT_PUBLIC_API_URL` is baked in at build time, `next build` loads the
root `.env`; set that variable to the deployed API origin or the built app will
call `localhost`.

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
| `pnpm --filter @breakpoint/db db:bootstrap` | Create or reset the platform system admin |
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
- [docs/teams.md](docs/teams.md) — creating a team, the two kinds of admin, the setup wizard
- [docs/roles.md](docs/roles.md) — the role model and the rules behind it
- [docs/migrations.md](docs/migrations.md) — database change rules
- [docs/documentation.md](docs/documentation.md) — what to document, and where
- [docs/product/](docs/product/) — scope and roadmap

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before pushing;
that is exactly what CI runs.
