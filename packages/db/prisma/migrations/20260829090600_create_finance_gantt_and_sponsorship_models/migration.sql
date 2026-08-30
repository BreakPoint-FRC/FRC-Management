-- The remaining modules: finance grows a season and a category, and task
-- history, Gantt boards and sponsorships arrive.

-- CreateEnum
CREATE TYPE "TaskActivityAction" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNEE_ADDED', 'ASSIGNEE_REMOVED', 'START_DATE_CHANGED', 'DUE_DATE_CHANGED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "SponsorshipStatus" AS ENUM ('CANDIDATE', 'CONTACTED', 'NEGOTIATING', 'SPONSOR', 'REJECTED', 'INACTIVE');

-- ---------------------------------------------------------------------------
-- Transaction -> FinanceTransaction
-- ---------------------------------------------------------------------------

-- RenameTable
ALTER TABLE "Transaction" RENAME TO "FinanceTransaction";
ALTER INDEX "Transaction_pkey" RENAME TO "FinanceTransaction_pkey";
ALTER TABLE "FinanceTransaction" RENAME CONSTRAINT "Transaction_id_not_null" TO "FinanceTransaction_id_not_null";
ALTER TABLE "FinanceTransaction" RENAME CONSTRAINT "Transaction_type_not_null" TO "FinanceTransaction_type_not_null";
ALTER TABLE "FinanceTransaction" RENAME CONSTRAINT "Transaction_amount_not_null" TO "FinanceTransaction_amount_not_null";
ALTER TABLE "FinanceTransaction" RENAME CONSTRAINT "Transaction_createdAt_not_null" TO "FinanceTransaction_createdAt_not_null";

-- RenameColumn
-- counterparty ("from who / to who") is free text about the other side of the
-- transaction, which is what description now holds. note is folded into the
-- same field rather than dropped, so nothing that was typed is lost.
ALTER TABLE "FinanceTransaction" RENAME COLUMN "counterparty" TO "description";
ALTER TABLE "FinanceTransaction" RENAME COLUMN "recordedById" TO "createdById";
ALTER TABLE "FinanceTransaction" ALTER COLUMN "description" DROP NOT NULL;
UPDATE "FinanceTransaction" SET "description" = "description" || ' - ' || "note" WHERE "note" IS NOT NULL;
ALTER TABLE "FinanceTransaction" DROP COLUMN "note";

-- AlterTable
-- The old model had no category. Existing rows are marked uncategorised rather
-- than guessed at.
ALTER TABLE "FinanceTransaction" ADD COLUMN "category" TEXT;
UPDATE "FinanceTransaction" SET "category" = 'Diger' WHERE "category" IS NULL;
ALTER TABLE "FinanceTransaction" ALTER COLUMN "category" SET NOT NULL;

ALTER TABLE "FinanceTransaction" ADD COLUMN "seasonId" TEXT;
UPDATE "FinanceTransaction" SET "seasonId" = (SELECT "id" FROM "Season" ORDER BY "startDate" LIMIT 1) WHERE "seasonId" IS NULL;
ALTER TABLE "FinanceTransaction" ALTER COLUMN "seasonId" SET NOT NULL;

ALTER TABLE "FinanceTransaction" ADD COLUMN "groupId" TEXT;

-- When the money moved is a separate fact from when the row was typed in. The
-- two are the same for everything recorded so far, so that is the honest
-- backfill.
ALTER TABLE "FinanceTransaction" ADD COLUMN "transactionDate" TIMESTAMP(3);
UPDATE "FinanceTransaction" SET "transactionDate" = "createdAt" WHERE "transactionDate" IS NULL;
ALTER TABLE "FinanceTransaction" ALTER COLUMN "transactionDate" SET NOT NULL;

ALTER TABLE "FinanceTransaction" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "FinanceTransaction" ALTER COLUMN "updatedAt" DROP DEFAULT;

UPDATE "FinanceTransaction" SET "createdById" = COALESCE(
  (SELECT ar."accountId" FROM "AccountRole" ar JOIN "Role" r ON r."id" = ar."roleId" WHERE r."key" = 'SYSTEM_ADMIN' ORDER BY ar."assignedAt" LIMIT 1),
  (SELECT "id" FROM "Account" ORDER BY "createdAt" LIMIT 1)
) WHERE "createdById" IS NULL;
ALTER TABLE "FinanceTransaction" ALTER COLUMN "createdById" SET NOT NULL;

-- Decimal with no precision is DECIMAL(65,30) in Postgres, which is 30 decimal
-- places of nothing for money. Narrowing to (12,2) is what the schema declares
-- and is wide enough for a season budget in kurus.
ALTER TABLE "FinanceTransaction" ALTER COLUMN "amount" TYPE DECIMAL(12,2);

-- DropForeignKey
ALTER TABLE "FinanceTransaction" DROP CONSTRAINT "Transaction_recordedById_fkey";

-- AddForeignKey
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "FinanceTransaction_seasonId_transactionDate_idx" ON "FinanceTransaction"("seasonId", "transactionDate");
CREATE INDEX "FinanceTransaction_seasonId_type_idx" ON "FinanceTransaction"("seasonId", "type");
CREATE INDEX "FinanceTransaction_groupId_idx" ON "FinanceTransaction"("groupId");
CREATE INDEX "FinanceTransaction_createdById_idx" ON "FinanceTransaction"("createdById");

-- ---------------------------------------------------------------------------
-- TaskActivity
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "TaskActivity" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" "TaskActivityAction" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskActivity_pkey" PRIMARY KEY ("id")
);

-- Existing tasks get the one entry that is actually known about them. Inventing
-- a status history nobody recorded would make the log lie.
INSERT INTO "TaskActivity" ("id", "taskId", "actorId", "action", "oldValue", "newValue", "createdAt")
SELECT gen_random_uuid()::text, "id", "createdById", 'CREATED', NULL, NULL, "createdAt"
FROM "Task";

-- ---------------------------------------------------------------------------
-- Gantt
-- ---------------------------------------------------------------------------

-- CreateTable
-- Ordering and nothing else. Dates, status and group stay on Task and are read
-- through the join, so a board cannot drift from the work it draws.
CREATE TABLE "GanttBoard" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "groupId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GanttBoard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GanttTask" (
    "ganttBoardId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GanttTask_pkey" PRIMARY KEY ("ganttBoardId","taskId")
);

-- ---------------------------------------------------------------------------
-- Sponsors
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Sponsorship" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "status" "SponsorshipStatus" NOT NULL DEFAULT 'CANDIDATE',
    "amount" DECIMAL(12,2),
    "assignedToId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsorship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskActivity_taskId_createdAt_idx" ON "TaskActivity"("taskId", "createdAt");
CREATE INDEX "TaskActivity_actorId_idx" ON "TaskActivity"("actorId");
CREATE UNIQUE INDEX "GanttBoard_seasonId_groupId_name_key" ON "GanttBoard"("seasonId", "groupId", "name");
CREATE INDEX "GanttBoard_seasonId_idx" ON "GanttBoard"("seasonId");
CREATE INDEX "GanttBoard_groupId_idx" ON "GanttBoard"("groupId");
CREATE INDEX "GanttTask_taskId_idx" ON "GanttTask"("taskId");
CREATE INDEX "GanttTask_ganttBoardId_displayOrder_idx" ON "GanttTask"("ganttBoardId", "displayOrder");
CREATE UNIQUE INDEX "Organization_name_key" ON "Organization"("name");

-- One relationship row per company per season. Without it a firm could be both
-- NEGOTIATING and REJECTED in 2026 and neither would be wrong.
CREATE UNIQUE INDEX "Sponsorship_organizationId_seasonId_key" ON "Sponsorship"("organizationId", "seasonId");
CREATE INDEX "Sponsorship_seasonId_status_idx" ON "Sponsorship"("seasonId", "status");
CREATE INDEX "Sponsorship_organizationId_idx" ON "Sponsorship"("organizationId");
CREATE INDEX "Sponsorship_assignedToId_idx" ON "Sponsorship"("assignedToId");

-- AddForeignKey
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GanttBoard" ADD CONSTRAINT "GanttBoard_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GanttBoard" ADD CONSTRAINT "GanttBoard_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GanttTask" ADD CONSTRAINT "GanttTask_ganttBoardId_fkey" FOREIGN KEY ("ganttBoardId") REFERENCES "GanttBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GanttTask" ADD CONSTRAINT "GanttTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Sponsorship" ADD CONSTRAINT "Sponsorship_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
