-- Turns a single-team instance into a multi-team one.
--
-- Until now the instance *was* the team: there was nothing to scope by, so
-- nothing was scoped. This adds Team and hangs every row that describes the
-- world of a team off it.
--
-- Existing data is adopted by one "Varsayilan Takim" row rather than deleted.
-- That team is created unconditionally, including on an empty CI database,
-- because the seed and the first-run bootstrap both need somewhere to put the
-- rows they create and a conditional insert here would make them branch.
--
-- teamId is denormalised onto Meeting/Task/GanttBoard/FinanceTransaction/
-- Sponsorship even though each could reach a team through its season. See the
-- comment in schema.prisma: the alternative is a join on every list query just
-- to prove a row belongs to the caller.

CREATE TYPE "TeamSetupStage" AS ENUM ('GROUPS', 'ROLES', 'TOOLS', 'PERMISSIONS', 'NAMING', 'ACCOUNTS', 'DONE');

CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "setupStage" "TeamSetupStage" NOT NULL DEFAULT 'GROUPS',
    "setupCompletedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Team_slug_key" ON "Team"("slug");
CREATE INDEX "Team_isActive_idx" ON "Team"("isActive");
CREATE INDEX "Team_createdById_idx" ON "Team"("createdById");

-- The team that adopts everything already in this database. Its id is a fixed
-- literal, not gen_random_uuid(), so the statements below can reference it
-- without a subquery and so a later migration can find it again.
INSERT INTO "Team" ("id", "name", "slug", "isActive", "setupStage", "setupCompletedAt", "createdAt", "updatedAt")
VALUES ('tm000000000000000000000000', 'Varsayilan Takim', 'varsayilan-takim', true, 'DONE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- --- Account -----------------------------------------------------------------
-- teamId stays nullable: null means a platform-level system admin, who belongs
-- to no team on purpose. Every account that exists today does belong to one.
ALTER TABLE "Account" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Account" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Account" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
CREATE INDEX "Account_teamId_idx" ON "Account"("teamId");

-- --- Group -------------------------------------------------------------------
ALTER TABLE "Group" ADD COLUMN "teamId" TEXT;
UPDATE "Group" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "Group" ALTER COLUMN "teamId" SET NOT NULL;
DROP INDEX "Group_name_key";
DROP INDEX "Group_isActive_idx";
CREATE UNIQUE INDEX "Group_teamId_name_key" ON "Group"("teamId", "name");
CREATE INDEX "Group_teamId_isActive_idx" ON "Group"("teamId", "isActive");

-- --- Season ------------------------------------------------------------------
ALTER TABLE "Season" ADD COLUMN "teamId" TEXT;
UPDATE "Season" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "Season" ALTER COLUMN "teamId" SET NOT NULL;
DROP INDEX "Season_name_key";
DROP INDEX "Season_isActive_idx";
CREATE UNIQUE INDEX "Season_teamId_name_key" ON "Season"("teamId", "name");
CREATE INDEX "Season_teamId_isActive_idx" ON "Season"("teamId", "isActive");

-- --- Organization ------------------------------------------------------------
ALTER TABLE "Organization" ADD COLUMN "teamId" TEXT;
UPDATE "Organization" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "Organization" ALTER COLUMN "teamId" SET NOT NULL;
DROP INDEX "Organization_name_key";
CREATE UNIQUE INDEX "Organization_teamId_name_key" ON "Organization"("teamId", "name");
CREATE INDEX "Organization_teamId_idx" ON "Organization"("teamId");

-- --- Operational tables ------------------------------------------------------
ALTER TABLE "Meeting" ADD COLUMN "teamId" TEXT;
UPDATE "Meeting" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "Meeting" ALTER COLUMN "teamId" SET NOT NULL;
CREATE INDEX "Meeting_teamId_idx" ON "Meeting"("teamId");

ALTER TABLE "Task" ADD COLUMN "teamId" TEXT;
UPDATE "Task" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "Task" ALTER COLUMN "teamId" SET NOT NULL;
CREATE INDEX "Task_teamId_idx" ON "Task"("teamId");

ALTER TABLE "GanttBoard" ADD COLUMN "teamId" TEXT;
UPDATE "GanttBoard" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "GanttBoard" ALTER COLUMN "teamId" SET NOT NULL;
CREATE INDEX "GanttBoard_teamId_idx" ON "GanttBoard"("teamId");

ALTER TABLE "FinanceTransaction" ADD COLUMN "teamId" TEXT;
UPDATE "FinanceTransaction" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "FinanceTransaction" ALTER COLUMN "teamId" SET NOT NULL;
CREATE INDEX "FinanceTransaction_teamId_idx" ON "FinanceTransaction"("teamId");

ALTER TABLE "Sponsorship" ADD COLUMN "teamId" TEXT;
UPDATE "Sponsorship" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;
ALTER TABLE "Sponsorship" ALTER COLUMN "teamId" SET NOT NULL;
CREATE INDEX "Sponsorship_teamId_idx" ON "Sponsorship"("teamId");

-- --- Foreign keys ------------------------------------------------------------
-- Team.createdById and Account.teamId point at each other. Both are nullable,
-- so Postgres accepts the cycle and neither insert order is forced.
--
-- Account is RESTRICT, not CASCADE: deleting a team must not silently delete
-- the people in it. Everything else cascades, because a group or a task without
-- its team is not a record, it is a leak.
ALTER TABLE "Team" ADD CONSTRAINT "Team_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Account" ADD CONSTRAINT "Account_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Group" ADD CONSTRAINT "Group_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Season" ADD CONSTRAINT "Season_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GanttBoard" ADD CONSTRAINT "GanttBoard_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
