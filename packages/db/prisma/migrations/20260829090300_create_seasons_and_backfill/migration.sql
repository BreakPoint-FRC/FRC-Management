-- Seasons, and the season every existing record belongs to.
--
-- Operational data hangs off a season so last season's tasks, meetings and
-- money stay readable and never get mixed into this season's totals.
--
-- seasonId is NOT NULL on populated tables, so the order here matters and is
-- the one docs/migrations.md asks for: create the table, put a row in it, add
-- the column nullable, backfill it, and only then tighten it. Adding a NOT NULL
-- column straight away works on an empty local database and fails on deploy.

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Season_name_key" ON "Season"("name");
CREATE INDEX "Season_isActive_idx" ON "Season"("isActive");
CREATE INDEX "Season_startDate_idx" ON "Season"("startDate");

-- Everything that already exists was made for the current season, so there is
-- one to attach it to. At most one season is active at a time; that rule lives
-- in seasons.service, not in a constraint, because "the current season" is a
-- workflow decision.
INSERT INTO "Season" ("id", "name", "startDate", "endDate", "isActive", "createdAt", "updatedAt")
VALUES (
  'season-2026',
  '2026 Season',
  '2026-01-03 00:00:00',
  '2026-12-31 23:59:59',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "seasonId" TEXT;
UPDATE "Meeting" SET "seasonId" = (SELECT "id" FROM "Season" ORDER BY "startDate" LIMIT 1) WHERE "seasonId" IS NULL;
ALTER TABLE "Meeting" ALTER COLUMN "seasonId" SET NOT NULL;

ALTER TABLE "Task" ADD COLUMN "seasonId" TEXT;
UPDATE "Task" SET "seasonId" = (SELECT "id" FROM "Season" ORDER BY "startDate" LIMIT 1) WHERE "seasonId" IS NULL;
ALTER TABLE "Task" ALTER COLUMN "seasonId" SET NOT NULL;

-- AddForeignKey
-- RESTRICT, not CASCADE: deleting a season must never quietly delete the
-- history it exists to preserve. Seasons are retired with isActive instead.
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
