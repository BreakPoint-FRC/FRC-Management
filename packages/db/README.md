# @breakpoint/db

Prisma schema, migrations, and the shared `PrismaClient` singleton. Consumed by
`apps/*` as a built package (`dist/`), never imported by path.

- Schema: [prisma/schema.prisma](prisma/schema.prisma)
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
