# Database migration rules

Every schema change goes through Prisma migrations. The database is shared —
once a migration is on `main`, someone else's database has already run it, and
changing it after the fact desynchronises everyone.

## Making a change

1. Edit [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma).
   The schema is the source of truth; never hand-write SQL and reconcile later.
2. Generate the migration:

   ```bash
   pnpm --filter @breakpoint/db db:migrate --name add_meeting_location
   ```

   Name it `snake_case`, verb first, describing the change —
   `add_meeting_location`, `drop_task_priority`, `index_transaction_created_at`.
   Not `update`, `fix`, or `migration2`.
3. **Read the generated `migration.sql` before committing it.** See the review
   checklist below.
4. Commit the whole `prisma/migrations/<timestamp>_<name>/` folder *and*
   `migration_lock.toml`. Both are version-controlled on purpose.
5. Regenerate the client if anything else consumes the new fields:

   ```bash
   pnpm db:generate
   ```

## An applied migration is immutable

Once a migration folder is on `main`:

- **Never** edit its `migration.sql`.
- **Never** delete or rename the folder.
- **Never** run `prisma migrate reset` against a database anyone else uses. It
  drops everything.

Got it wrong? Fix forward — write a *new* migration that corrects it. Prisma
records applied migrations by checksum; editing one in place makes every other
clone fail with a drift error that is far more painful than the original bug.

## dev vs deploy

| Command | Where | What it does |
| --- | --- | --- |
| `pnpm --filter @breakpoint/db db:migrate` | Your machine only | Creates a new migration from schema changes, applies it, regenerates the client. Interactive — it may offer to reset. |
| `pnpm --filter @breakpoint/db db:deploy` | CI and production | Applies pending migrations. Never creates, never prompts, never drops. |

Only `db:deploy` runs against a real environment. If you are typing
`db:migrate` anywhere but your own machine, stop.

## Destructive changes ship in two migrations

Renaming or dropping a populated column in one step loses data, because a
running instance of the old code is still writing to it. Split it:

1. **PR one** — add the new column, backfill it, write to both.
2. Ship, confirm it is live and correct.
3. **PR two** — stop writing the old column, then drop it.

Same for renames: add + backfill + switch reads, then drop. A rename in Prisma
generates a `DROP` and an `ADD`, not a `RENAME`, unless you edit the SQL before
it has ever been applied — which is the one and only time editing is allowed.

## Review checklist

Read the SQL, not just the schema diff:

- Any `DROP TABLE` or `DROP COLUMN` you did not intend? Prisma emits them for
  renames.
- A new `NOT NULL` column on a populated table without a `DEFAULT`? It will
  fail on deploy even though it worked on your empty local database.
- A new foreign key column without an index? Postgres does not create one
  automatically, and the join will get slow as the season goes on.
- A new `@unique` on existing data? It fails if duplicates already exist.
- Does the migration assume data that only your machine has?

## Seed data

[packages/db/prisma/seed.ts](../packages/db/prisma/seed.ts) fills an empty
database with a realistic team so the pages are not blank:

```bash
pnpm --filter @breakpoint/db db:seed
```

It is idempotent — every row is an `upsert` on a fixed `seed-*` id — so running
it twice is safe. When you add a model, add a couple of rows for it here too;
the seed is the first thing a new contributor sees.
