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

## Write SQL that runs on the CI server, not just yours

CI runs `postgres:16-alpine` ([ci.yml](../.github/workflows/ci.yml)), and it
builds the database from empty on every run. A local Postgres that is newer will
happily accept SQL that server rejects, and you will not find out until the
pipeline is red on a branch that worked all day.

The one that has already bitten us: **PostgreSQL 18 gives every `NOT NULL` its
own named catalog entry** (`Member_id_not_null`), and 16 and 17 do not — there a
`NOT NULL` is a column attribute with no name. So
`ALTER TABLE ... RENAME CONSTRAINT "Member_id_not_null" ...` succeeds on 18 and
fails with `42704 constraint does not exist` on 16. Three migrations in this
repo did that and had to be made conditional; see the loop at the top of
[20260829090000](../packages/db/prisma/migrations/20260829090000_rename_member_to_account_and_add_credentials/migration.sql)
for the shape to copy.

Note what this rules out: fixing it forward was **not** an option. The failing
migration is fifth of thirteen, so on a fresh database nothing after it can run
— a later migration correcting it would never be reached. A migration that
cannot apply at all on an empty database has to be repaired in place, which is
only allowed because it had not reached `main`.

Two habits avoid the whole class of problem:

- Prefer version-agnostic SQL. If you must touch something a newer server names
  and an older one does not, guard it with a `pg_constraint` lookup instead of
  assuming it exists.
- Before pushing a hand-written migration, replay the whole chain from empty
  against the CI image, not against your own database:

  ```bash
  docker run -d --name bp-pg16 -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_USER=postgres -e POSTGRES_DB=breakpoint \
    -p 55432:5432 postgres:16-alpine

  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/breakpoint" \
    pnpm --filter @breakpoint/db exec prisma migrate deploy

  docker rm -f bp-pg16
  ```

  `db:deploy` against a database that already has the tables proves nothing:
  the bug only exists on the path CI takes, which is from nothing.

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
