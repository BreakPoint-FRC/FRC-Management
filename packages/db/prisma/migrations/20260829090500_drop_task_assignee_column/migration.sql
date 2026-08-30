-- Step two of the assignee change. The previous migration created TaskAssignee
-- and copied every existing assignment into it; this one stops the old column
-- from existing.
--
-- Split in two on purpose (docs/migrations.md, "destructive changes ship in two
-- migrations"): between the two, both shapes are readable, so an instance of
-- the old code still running against the new database can finish its requests
-- instead of erroring on a column that vanished mid-deploy.

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_assigneeId_fkey";

-- DropColumn
ALTER TABLE "Task" DROP COLUMN "assigneeId";
