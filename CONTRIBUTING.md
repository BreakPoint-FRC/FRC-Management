# Contributing to BreakPoint

Read this once before your first change. It covers how to get set up, how the
code is laid out, and what has to be true before a pull request is merged.

Two companion documents hold the rules this one references:

- [docs/migrations.md](docs/migrations.md) — database change rules
- [docs/documentation.md](docs/documentation.md) — what you must document, and where

## Setup

```bash
cp .env.example .env                        # do this FIRST
pnpm install                                # runs `prisma generate` on install
docker compose up -d                        # local Postgres on :5432
pnpm --filter @breakpoint/db db:migrate     # apply migrations
pnpm --filter @breakpoint/db db:seed        # sample data, so pages aren't empty
pnpm dev                                    # api on :4000, web on :3000
```

Working on one app only? `pnpm dev:api` or `pnpm dev:web` — see the README's
Scripts table for how they differ from `pnpm dev`.

Copy `.env` first. `packages/db` runs `prisma generate` in its `postinstall`;
that step tolerates a missing `DATABASE_URL` and prints a warning instead of
failing, but every command that touches the database — `db:migrate`,
`db:deploy`, `db:seed`, `db:studio` — needs it set.

Node version is pinned in [.nvmrc](.nvmrc) (20). pnpm version is pinned by
`packageManager` in [package.json](package.json) — use `corepack enable` and let
it pick the right one rather than installing pnpm globally.

## Branches

Branch off `main`, never push to `main` directly:

- `feat/<short-description>` — new behaviour
- `fix/<short-description>` — bug fix
- `chore/<short-description>` — tooling, deps, config
- `docs/<short-description>` — documentation only

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), with the workspace
as the scope — `api`, `web`, `db`, `types`, `config`, or `docs`:

```
feat(api): add meeting attendance bulk update
fix(web): stop the finance table flickering on refetch
chore(db): bump prisma to 7.7
docs(migrations): explain the two-step rename rule
```

The subject line says what changed, not what file you touched. If you cannot
write one line describing the change, the commit is probably two commits.

## Before you push

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

All four must pass. CI runs exactly this, so a green local run means a green
pipeline. `pnpm typecheck` and `pnpm test` build `packages/*` first — that is
deliberate, `apps/*` consume the built output, not the source.

## Code layout

The structure is already consistent. Follow what is there instead of inventing a
second pattern.

**An API feature is four files** under `apps/api/src/modules/<feature>/`:

| File | Holds |
| --- | --- |
| `<feature>.schema.ts` | Zod schemas for request bodies and params, plus the inferred input types |
| `<feature>.service.ts` | A `create<Feature>Service(prisma)` factory returning the data functions — all Prisma access lives here |
| `<feature>.routes.ts` | The Fastify plugin: parse with the schema, call the service, return |
| `<feature>.test.ts` | Vitest suite against `buildApp({ prisma: stub })` |

Copy [seasons](apps/api/src/modules/seasons/) as the reference; it is the
smallest complete example. Read [tasks](apps/api/src/modules/tasks/) when you
need a harder one — cross-field validation, set replacement, and an audit log
written in the same transaction as the change it describes. Register the new
plugin in [apps/api/src/app.ts](apps/api/src/app.ts) with a `prefix`.

**Every route is authorized on the server.** Put `app.addHook("preHandler",
app.authenticate)` at the top of the plugin, then call `authorize()` from
[apps/api/src/lib/authorize.ts](apps/api/src/lib/authorize.ts) in each handler
with the tool, the action, and — for anything belonging to a department — the
group, read from the *stored row* rather than the request body. Read
[docs/authorization.md](docs/authorization.md) before adding a route; the
reasoning for the order and for reading the group off the record is there, and
getting either wrong is the kind of bug that looks like it works.

**List endpoints paginate.** Extend `paginationSchema` from `@breakpoint/types`
and return `paginated(...)` from
[apps/api/src/lib/pagination.ts](apps/api/src/lib/pagination.ts). Fetch the page
and its count in one `$transaction` so the two cannot describe different sets of
rows.

**Assignments are replaced whole.** Roles, permissions, group tools, task
assignees and meeting attendance all arrive as a complete set through a single
`PUT`. Do not add an add-one or remove-one endpoint without reading why in
[docs/authorization.md](docs/authorization.md) — the invariants are set-level,
and a partial write cannot be validated against rules it cannot see.

**Shared shapes go in `packages/types`.** Anything the web app and the API both
need — response shapes, enums, validation — belongs in
[packages/types/src/](packages/types/src/) and is imported from
`@breakpoint/types`. Do not redeclare an interface in `apps/web` that already
exists there. Display helpers count as shared shapes too: the Turkish labels for
statuses and priorities, and the functions that format a role list, are already
there — see [docs/roles.md](docs/roles.md) rather than writing a second label
map. Role and department names are not among them: those live in the database,
so a team can rename a position without a deploy.

**The web app fetches on the client.** `lib/api-client.ts` keeps the access
token in module memory, so a server component has neither a token nor the
refresh cookie and would fetch as an anonymous user. Every page under
`app/(dashboard)/` is therefore `"use client"` and loads through
[hooks/use-api.ts](apps/web/hooks/use-api.ts). That is a consequence of where
the token lives, not a preference — moving data loading to the server means
first deciding how the cookie gets there.

**Response shapes live in [lib/api-types.ts](apps/web/lib/api-types.ts), not in
the page.** They are not duplicates of `@breakpoint/types`: those schemas
describe a *parsed* record (`taskSchema` coerces dates, so `dueDate` is a
`Date`), while what arrives over the wire is JSON — dates are strings, and a
list row carries joined-in fields like `groupName` and `assignees` that the
entity has no notion of. Enums, labels and helpers still come from the shared
package. Also note Next refuses any runtime export from a `page.tsx` other than
the default and its own metadata fields, so a shared helper has to live outside
the page anyway.

**`can()` decides what to draw, never what is allowed.**
[lib/permissions.ts](apps/web/lib/permissions.ts) reads the map from
`GET /auth/me` to hide links and buttons. It is cosmetic. The request behind
every control is authorized again by the server on every call, and a client that
lies to itself about that map gets a 403 — see
[docs/authorization.md](docs/authorization.md).

**Writes go through `useMutation` and a `FormPanel`.**
[hooks/use-mutation.ts](apps/web/hooks/use-mutation.ts) runs the call and keeps
the `ApiError` rather than rethrowing, so a form can stay open on a failure;
[components/ui/form.tsx](apps/web/components/ui/form.tsx) renders the panel and
the fields. Field-level messages come from
[lib/issues.ts](apps/web/lib/issues.ts), which matches the API's issue paths
(`["roles", 1]`) against the control that owns them. A 403 or 409 has no field
to sit under, so it goes in the panel banner instead.

**Assignments are replaced whole in the UI too.** Roles, permissions, group
tools, task assignees, meeting attendance and Gantt ordering are all a single
`PUT` carrying the entire list -- see
[docs/authorization.md](docs/authorization.md) for why. Seed the editor from
what is stored and send all of it back; anything you leave out is deleted.

**Charts are Recharts; everything else is hand-written.** `recharts` is the
only runtime dependency `apps/web` has beyond Next and React, and it is a
deliberate exception rather than the start of a habit. Drawing a date axis with
ticks, a hover tooltip and a line on today is a solved problem worth importing;
a button is not. The "one stylesheet, no framework" note at the top of
[globals.css](apps/web/app/globals.css) still stands — it is about styling, and
nothing here brings in a CSS framework.

Two rules come with it. **Chart colours are `--chart-*` tokens, never hex in a
component**: Recharts takes colours as JS props, but SVG `fill` accepts
`var()`, so dark mode stays the single `prefers-color-scheme` block that
`globals.css` promises. And **every chart is loaded with `next/dynamic` and
`ssr: false`** — it keeps a few hundred kilobytes out of the first load of an
installable PWA, and `ResponsiveContainer` has nothing to measure on the
server. See [components/gantt/timeline-chart.tsx](apps/web/components/gantt/timeline-chart.tsx)
for the shape of one.

**Never import across workspaces by path.** `apps/*` import the built packages
(`@breakpoint/db`, `@breakpoint/types`), never `../../packages/...`. The
packages compile to `dist/`, and reaching past that breaks the build order.

**Errors.** Throw `NotFoundError`, `UnauthorizedError`, `ForbiddenError` or
`ConflictError` from
[apps/api/src/lib/http-errors.ts](apps/api/src/lib/http-errors.ts), or let Zod
and Prisma errors bubble up — the error handler in
[apps/api/src/app.ts](apps/api/src/app.ts) maps those to 404/401/403/409, Zod to
400, and Prisma's `P2025`/`P2002`/`P2003` to 404/409/400. Prefer an explicit
`ConflictError` with a message that says what happened over letting a foreign
key surface as `P2003`, which reads "Referenced record does not exist" no matter
what the actual problem was. Never `reply.send(error)` yourself: the
handler exists so that unexpected errors return a bare 500 instead of leaking
Prisma internals and absolute file paths to the client.

**Services take `prisma` as an argument.** That is what lets the tests inject a
stub instead of standing up a database.

## Pull request checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes locally
- [ ] New or changed endpoints have tests in the module's `.test.ts`
- [ ] Any schema change follows [docs/migrations.md](docs/migrations.md), and the generated SQL is in the diff and has been read
- [ ] Any change to member roles keeps [docs/roles.md](docs/roles.md) true
- [ ] Any new env var is in `.env.example`
- [ ] Docs updated per [docs/documentation.md](docs/documentation.md)
- [ ] No `.env`, `dist/`, `node_modules/`, or generated Prisma client in the diff

Keep pull requests to one concern. A PR that changes the schema, adds an
endpoint, and reformats three unrelated files is three reviews pretending to be
one.
