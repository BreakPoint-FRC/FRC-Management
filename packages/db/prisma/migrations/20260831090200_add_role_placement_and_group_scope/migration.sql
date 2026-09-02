-- Roles gain a team, a placement, and a set of groups they have authority over.
--
-- The old RoleScope could say "this one group" (GROUP, scoped by
-- AccountRole.groupId) or "every group" (GLOBAL). There was no way to write
-- "the Technical Director runs Mechanical, Software and Electrical but has no
-- business in Media", which is what RolePlacement + RoleGroupScope add.
--
-- This migration is additive on purpose. "scope" is still here and still
-- populated; 20260831090400 drops it once nothing reads it (docs/migrations.md,
-- "Destructive changes ship in two migrations").

CREATE TYPE "RolePlacement" AS ENUM ('IN_GROUP', 'MANAGES_GROUP', 'ABOVE_GROUPS', 'TEAM_WIDE', 'EXTERNAL');

ALTER TABLE "Role" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Role" ADD COLUMN "placement" "RolePlacement";

-- Every role that exists today was written for the one team that existed today.
-- The platform-level SYSTEM_ADMIN with a null teamId is created by the next
-- migration, not by converting one of these.
UPDATE "Role" SET "teamId" = 'tm000000000000000000000000' WHERE "teamId" IS NULL;

-- The faithful mapping, chosen to preserve behaviour exactly rather than to
-- guess intent:
--
--   GLOBAL -> TEAM_WIDE  covers every group, as GLOBAL did.
--   GROUP  -> IN_GROUP   still scoped by AccountRole.groupId, as GROUP was.
--
-- LEAD is tempting to call MANAGES_GROUP, and it is not. MANAGES_GROUP takes
-- its coverage from RoleGroupScope and ignores AccountRole.groupId, so
-- promoting LEAD here would detach every existing lead from the department they
-- were assigned to. A team that wants a real MANAGES_GROUP role creates one.
-- MENTOR keeps TEAM_WIDE for the same reason: EXTERNAL covers no group and
-- would quietly take reads away.
UPDATE "Role"
SET "placement" = CASE WHEN "scope" = 'GLOBAL' THEN 'TEAM_WIDE'::"RolePlacement" ELSE 'IN_GROUP'::"RolePlacement" END
WHERE "placement" IS NULL;

ALTER TABLE "Role" ALTER COLUMN "placement" SET NOT NULL;

-- Role keys are unique per team now: two teams may both call a position LEAD.
--
-- Postgres treats NULLs as distinct inside a unique index, so this does not
-- stop a second platform role (teamId null) with the same key -- the same gap
-- documented for AccountRole. Platform roles are only ever written by
-- migrations, which is what closes it.
DROP INDEX "Role_key_key";
DROP INDEX "Role_scope_idx";
CREATE UNIQUE INDEX "Role_teamId_key_key" ON "Role"("teamId", "key");
CREATE INDEX "Role_teamId_placement_idx" ON "Role"("teamId", "placement");

ALTER TABLE "Role" ADD CONSTRAINT "Role_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which groups a role has authority over.
--
-- Stores the roots of that authority, not its closure: a row on Teknik covers
-- Tasarim three levels below it, resolved at request time by walking the group
-- tree. Storing the closure would mean rewriting every role whenever somebody
-- adds a subgroup.
--
-- Required for MANAGES_GROUP and ABOVE_GROUPS, forbidden for TEAM_WIDE and
-- EXTERNAL, optional for IN_GROUP. That is conditional on a column in another
-- table, so roles.service enforces it rather than a constraint.
CREATE TABLE "RoleGroupScope" (
    "roleId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleGroupScope_pkey" PRIMARY KEY ("roleId", "groupId")
);

CREATE INDEX "RoleGroupScope_groupId_idx" ON "RoleGroupScope"("groupId");

ALTER TABLE "RoleGroupScope" ADD CONSTRAINT "RoleGroupScope_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleGroupScope" ADD CONSTRAINT "RoleGroupScope_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
