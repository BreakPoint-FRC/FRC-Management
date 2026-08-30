-- Fixes a gap left by 20260829090200: the permission matrix gives LEAD read on
-- ACCOUNTS so a lead can see who is in their department, but no group had
-- ACCOUNTS enabled in GroupTool, so step 5 of the authorization check rejected
-- the request before the role was ever consulted. A department lead got a 403
-- reading their own roster.
--
-- The earlier migration called the administrative tools "GLOBAL-scope, never
-- reached through a group". That is true of ROLES, TOOLS, PERMISSIONS and
-- SEASONS, and wrong for the two that describe a department: who is in it, and
-- what it is. Those are exactly what a lead runs.
--
-- Fixed forward rather than by editing the earlier migration, which has been
-- applied (docs/migrations.md).

-- Every group can be looked at, and its roster read, by whoever holds the
-- permission. The remaining administrative tools stay team-wide.
INSERT INTO "GroupTool" ("groupId", "toolId", "isEnabled", "updatedAt")
SELECT grp."id", tool."id", true, CURRENT_TIMESTAMP
FROM "Group" grp
CROSS JOIN "Tool" tool
WHERE tool."key" IN ('ACCOUNTS', 'GROUPS')
ON CONFLICT ("groupId", "toolId") DO NOTHING;

-- A lead runs a department, so they can see the department record itself, not
-- only its people. Read only: renaming a group or switching its tools on and
-- off stays a team-wide act.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", true, false, false, false
FROM "Role" role
JOIN "Tool" tool ON tool."key" = 'GROUPS'
WHERE role."key" = 'LEAD'
ON CONFLICT ("roleId", "toolId") DO NOTHING;
