-- Meetings and tasks grow into the full model: an author, a group, a priority,
-- a real status vocabulary, per-person attendance and more than one assignee.
--
-- Every column that exists under a different name is RENAMEd, not dropped and
-- re-added. Prisma's diff for a rename is DROP + ADD, which silently empties
-- the column -- Meeting.report and Task.title hold the only copy of that text.

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- ---------------------------------------------------------------------------
-- Meeting
-- ---------------------------------------------------------------------------

-- RenameColumn
ALTER TABLE "Meeting" RENAME COLUMN "scheduledAt" TO "meetingDate";
ALTER TABLE "Meeting" RENAME COLUMN "report" TO "body";
ALTER TABLE "Meeting" RENAME CONSTRAINT "Meeting_scheduledAt_not_null" TO "Meeting_meetingDate_not_null";

-- AlterTable
-- groupId is nullable: a team-wide meeting belongs to no single department, and
-- a null group is what sends the authorization check down the GLOBAL path.
ALTER TABLE "Meeting" ADD COLUMN "groupId" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Meeting" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Existing meetings predate the idea of an author. They are attributed to the
-- first system admin, falling back to the oldest account. If neither exists the
-- SET NOT NULL below fails loudly, which is the right outcome: a meeting with
-- no possible author means the database is in a state this migration cannot
-- honestly repair.
ALTER TABLE "Meeting" ADD COLUMN "createdById" TEXT;
UPDATE "Meeting" SET "createdById" = COALESCE(
  (SELECT ar."accountId" FROM "AccountRole" ar JOIN "Role" r ON r."id" = ar."roleId" WHERE r."key" = 'SYSTEM_ADMIN' ORDER BY ar."assignedAt" LIMIT 1),
  (SELECT "id" FROM "Account" ORDER BY "createdAt" LIMIT 1)
) WHERE "createdById" IS NULL;
ALTER TABLE "Meeting" ALTER COLUMN "createdById" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Task
-- ---------------------------------------------------------------------------

-- RenameColumn
ALTER TABLE "Task" RENAME COLUMN "title" TO "name";
ALTER TABLE "Task" RENAME COLUMN "dueAt" TO "dueDate";
ALTER TABLE "Task" RENAME CONSTRAINT "Task_title_not_null" TO "Task_name_not_null";

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "Task" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Task" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "Task" ADD COLUMN "createdById" TEXT;
UPDATE "Task" SET "createdById" = COALESCE(
  "assigneeId",
  (SELECT ar."accountId" FROM "AccountRole" ar JOIN "Role" r ON r."id" = ar."roleId" WHERE r."key" = 'SYSTEM_ADMIN' ORDER BY ar."assignedAt" LIMIT 1),
  (SELECT "id" FROM "Account" ORDER BY "createdAt" LIMIT 1)
) WHERE "createdById" IS NULL;
ALTER TABLE "Task" ALTER COLUMN "createdById" SET NOT NULL;

-- AlterEnum
-- TaskStatus is rebuilt rather than extended: DONE is gone and four values are
-- new. The USING clause is hand-written -- Prisma generates a plain
-- ("status"::text::"TaskStatus_new") cast, which fails on every existing DONE
-- row. They become COMPLETED. This is the same shape as the worked example in
-- 20260825063641_replace_role_with_subteam_and_position.
BEGIN;
CREATE TYPE "TaskStatus_new" AS ENUM ('BACKLOG', 'TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED');
ALTER TABLE "public"."Task" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus_new" USING (
    CASE "status"::text WHEN 'DONE' THEN 'COMPLETED' ELSE "status"::text END
)::"TaskStatus_new";
ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
DROP TYPE "public"."TaskStatus_old";
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'TODO';
COMMIT;

-- ---------------------------------------------------------------------------
-- Attendance -> MeetingAttendance
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "MeetingAttendance" (
    "meetingId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'ABSENT',
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingAttendance_pkey" PRIMARY KEY ("meetingId","accountId")
);

-- A boolean cannot say "late" or "excused", which is most of what roll call is
-- actually recording. The two values it could say carry over unchanged.
INSERT INTO "MeetingAttendance" ("meetingId", "accountId", "status", "note", "updatedAt")
SELECT
  legacy."meetingId",
  legacy."memberId",
  CASE WHEN legacy."present" THEN 'PRESENT'::"AttendanceStatus" ELSE 'ABSENT'::"AttendanceStatus" END,
  NULL,
  CURRENT_TIMESTAMP
FROM "Attendance" legacy
ON CONFLICT ("meetingId", "accountId") DO NOTHING;

-- DropTable
DROP TABLE "Attendance";

-- ---------------------------------------------------------------------------
-- Task.assigneeId -> TaskAssignee
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "TaskAssignee" (
    "taskId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskAssignee_pkey" PRIMARY KEY ("taskId","accountId")
);

-- Backfill only. Task.assigneeId is deliberately still here and still written
-- to: dropping a populated column in the same migration that starts reading its
-- replacement is the destructive one-step change docs/migrations.md splits in
-- two. The drop is the next migration.
INSERT INTO "TaskAssignee" ("taskId", "accountId", "assignedAt")
SELECT "id", "assigneeId", COALESCE("createdAt", CURRENT_TIMESTAMP)
FROM "Task"
WHERE "assigneeId" IS NOT NULL
ON CONFLICT ("taskId", "accountId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Constraints and indexes
-- ---------------------------------------------------------------------------

-- Task.groupId already had a foreign key, but with the old delete behaviour.
-- A group must not be deletable out from under the tasks that reference it.
-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_groupId_fkey";

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MeetingAttendance" ADD CONSTRAINT "MeetingAttendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MeetingAttendance" ADD CONSTRAINT "MeetingAttendance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAssignee" ADD CONSTRAINT "TaskAssignee_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Postgres does not index a foreign key column for you, and every one of these
-- is joined or filtered on in a list endpoint.
CREATE INDEX "Meeting_seasonId_meetingDate_idx" ON "Meeting"("seasonId", "meetingDate");
CREATE INDEX "Meeting_groupId_idx" ON "Meeting"("groupId");
CREATE INDEX "Meeting_createdById_idx" ON "Meeting"("createdById");
CREATE INDEX "MeetingAttendance_accountId_idx" ON "MeetingAttendance"("accountId");
CREATE INDEX "MeetingAttendance_status_idx" ON "MeetingAttendance"("status");
CREATE INDEX "Task_seasonId_groupId_status_idx" ON "Task"("seasonId", "groupId", "status");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_dueDate_idx" ON "Task"("dueDate");
CREATE INDEX "Task_groupId_idx" ON "Task"("groupId");
CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");
CREATE INDEX "TaskAssignee_accountId_idx" ON "TaskAssignee"("accountId");
