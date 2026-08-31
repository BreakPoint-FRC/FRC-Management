-- Splits "admin" into the two things it was doing at once.
--
-- Until now one SYSTEM_ADMIN role ran the only team there was. With many teams
-- those are two different jobs:
--
--   SYSTEM_ADMIN  platform level, teamId null. Opens teams, creates the team
--                 admin who will run each one, and creates other system admins.
--                 Belongs to no team -- one that sat inside a team would be a
--                 back door into it.
--   TEAM_ADMIN    runs one team. Everything inside it, nothing outside it.
--
-- Neither is a flag or a branch in the code. Both are role rows with a
-- permission matrix, which is what keeps "if (isAdmin)" out of the codebase --
-- see docs/authorization.md.

-- "scope" stops being required here, before the first row is written that has
-- no meaningful value for it.
--
-- 20260831090200 added "placement" and left "scope" populated and NOT NULL,
-- because dropping a column is the second half of a two-step and that half is
-- 20260831090400. But the platform SYSTEM_ADMIN inserted below is written
-- *after* placement took over, so there is nothing to put in the old column.
-- Relaxing the constraint is what "stop writing the old column" means in
-- practice; the column itself still goes in 090400.
ALTER TABLE "Role" ALTER COLUMN "scope" DROP NOT NULL;

-- The tool the platform admin administers. TEAMS is team-wide like ROLES and
-- SEASONS, so it gets no GroupTool rows: a missing row reads as disabled, which
-- is the correct answer for a department asking about team creation.
INSERT INTO "Tool" ("id", "key", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'TEAMS', 'Takimlar', 'Takim acma, arsivleme ve takim yoneticisi atama.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- The existing SYSTEM_ADMIN was this team's administrator, so that is what it
-- becomes. Renaming rather than deleting keeps every RolePermission,
-- RoleHierarchy edge and AccountRole pointing at it intact -- whoever was the
-- admin yesterday is the team admin today, with the same matrix.
UPDATE "Role"
SET "key" = 'TEAM_ADMIN',
    "name" = 'Takim Yoneticisi',
    "description" = 'Takimin tamamini yonetir: gruplar, roller, moduller, izinler ve hesaplar.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'SYSTEM_ADMIN' AND "teamId" IS NOT NULL;

-- Safety net for any team that somehow has none. A team without a team admin
-- cannot be administered at all, and there is no second way in.
INSERT INTO "Role" ("id", "teamId", "key", "name", "description", "placement", "isSystemRole", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, team."id", 'TEAM_ADMIN', 'Takim Yoneticisi',
       'Takimin tamamini yonetir: gruplar, roller, moduller, izinler ve hesaplar.',
       'TEAM_WIDE'::"RolePlacement", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Team" team
WHERE NOT EXISTS (
  SELECT 1 FROM "Role" existing WHERE existing."teamId" = team."id" AND existing."key" = 'TEAM_ADMIN'
);

-- TEAM_ADMIN gets every tool outright rather than by inheritance: its power must
-- not depend on the shape of a role tree that a team admin can edit.
--
-- Every tool except TEAMS. Running a team does not include opening new ones.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", true, true, true, true
FROM "Role" role
CROSS JOIN "Tool" tool
WHERE role."key" = 'TEAM_ADMIN' AND tool."key" <> 'TEAMS'
ON CONFLICT ("roleId", "toolId") DO NOTHING;

-- The platform role. teamId null is what puts it above every team.
--
-- Fixed id rather than gen_random_uuid() so the bootstrap command and any later
-- migration can find it without matching on a key that a team could also use.
INSERT INTO "Role" ("id", "teamId", "key", "name", "description", "placement", "isSystemRole", "createdAt", "updatedAt")
VALUES ('rl00000000000000systemadmin', NULL, 'SYSTEM_ADMIN', 'Sistem Yoneticisi',
        'Platform yoneticisi. Takim acar, takim yoneticisi ve diger sistem yoneticisi hesaplarini olusturur.',
        'TEAM_WIDE'::"RolePlacement", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Every tool, TEAMS included. The CROSS JOIN covers the tools that exist when
-- this migration runs and knows nothing about one added later, so a future tool
-- needs its own SYSTEM_ADMIN grant -- the same four lines
-- 20260829091000_add_calendar_tool spells out.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, 'rl00000000000000systemadmin', tool."id", true, true, true, true
FROM "Tool" tool
ON CONFLICT ("roleId", "toolId") DO NOTHING;

-- No account is given the platform role here. Handing one out in a migration
-- would put a known-holder admin in every deployment; the bootstrap command
-- (pnpm --filter @breakpoint/db db:bootstrap) creates it from environment
-- variables instead, once, on purpose.
