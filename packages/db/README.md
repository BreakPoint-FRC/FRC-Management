# @breakpoint/db

Prisma schema, migrations, and the shared `PrismaClient` singleton. Consumed by
`apps/*` as a built package (`dist/`), never imported by path.

- Schema: [prisma/schema.prisma](prisma/schema.prisma)
- Roles: `Account` deliberately has no `role` column and no permission flags —
  an account holds a list of `AccountRole` rows, each optionally scoped to a
  `Group`. Read [../../docs/roles.md](../../docs/roles.md) before touching
  `Role`, `AccountRole`, `RoleHierarchy`, or `Group`, and
  [../../docs/authorization.md](../../docs/authorization.md) before touching
  `Tool`, `GroupTool`, or `RolePermission`
- Configuration vs sample data: the roles, tools, permission matrix and
  departments are written by migrations, not by the seed. Without them nobody
  can be authorized for anything, so a freshly deployed database would be
  inert. The seed adds a team on top
- Client: [src/client.ts](src/client.ts) — one instance, reused across hot
  reloads in development
- Seed: [prisma/seed.ts](prisma/seed.ts) — idempotent sample data

**Before changing the schema, read [../../docs/migrations.md](../../docs/migrations.md).**
The short version: the schema is the source of truth, an applied migration is
immutable (fix forward, never edit), and `db:migrate` is for your machine while
`db:deploy` is for CI and production.

```bash
pnpm --filter @breakpoint/db db:migrate --name add_something   # create + apply
pnpm --filter @breakpoint/db db:deploy                         # apply only
pnpm --filter @breakpoint/db db:seed                           # sample data
pnpm --filter @breakpoint/db db:studio                         # browse the data
```

The generated client lands in `src/generated/` and is gitignored — it is rebuilt
by `prisma generate`, which runs automatically on `pnpm install`.
