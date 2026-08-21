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

Copy [members](apps/api/src/modules/members/) as the reference; it is the
smallest complete example. Register the new plugin in
[apps/api/src/app.ts](apps/api/src/app.ts) with a `prefix`.

**Shared shapes go in `packages/types`.** Anything the web app and the API both
need — response shapes, enums, validation — belongs in
[packages/types/src/](packages/types/src/) and is imported from
`@breakpoint/types`. Do not redeclare an interface in `apps/web` that already
exists there.

**Never import across workspaces by path.** `apps/*` import the built packages
(`@breakpoint/db`, `@breakpoint/types`), never `../../packages/...`. The
packages compile to `dist/`, and reaching past that breaks the build order.

**Errors.** Throw `NotFoundError` from
[apps/api/src/lib/http-errors.ts](apps/api/src/lib/http-errors.ts), or let Zod
and Prisma errors bubble up — the error handler in
[apps/api/src/app.ts](apps/api/src/app.ts) maps `ZodError` to 400 and Prisma's
`P2025`/`P2002`/`P2003` to 404/409/400. Never `reply.send(error)` yourself: the
handler exists so that unexpected errors return a bare 500 instead of leaking
Prisma internals and absolute file paths to the client.

**Services take `prisma` as an argument.** That is what lets the tests inject a
stub instead of standing up a database.

## Pull request checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes locally
- [ ] New or changed endpoints have tests in the module's `.test.ts`
- [ ] Any schema change follows [docs/migrations.md](docs/migrations.md), and the generated SQL is in the diff and has been read
- [ ] Any new env var is in `.env.example`
- [ ] Docs updated per [docs/documentation.md](docs/documentation.md)
- [ ] No `.env`, `dist/`, `node_modules/`, or generated Prisma client in the diff

Keep pull requests to one concern. A PR that changes the schema, adds an
endpoint, and reformats three unrelated files is three reviews pretending to be
one.
