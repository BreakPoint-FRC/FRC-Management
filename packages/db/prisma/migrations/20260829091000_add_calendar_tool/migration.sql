-- Registers the CALENDAR tool.
--
-- No DDL: Tool.key is a String, not a Postgres enum, precisely so that adding a
-- module is a row rather than a type change. The schema is untouched -- what
-- changes is the permission vocabulary, which lives in data.
--
-- The calendar owns no records. It draws dates that already belong to meetings
-- and tasks, so it is read-only by construction and the create/update/delete
-- flags stay false for everyone below SYSTEM_ADMIN. Reading it still does not
-- reveal anything new: the route checks MEETINGS and TASKS read separately and
-- only fills the sources the account may already see.

INSERT INTO "Tool" ("id", "key", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'CALENDAR', 'Takvim', 'Toplanti ve gorev tarihlerinin ay gorunumu.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Every department plans against a calendar, so unlike FINANCE and SPONSORS
-- this one is on everywhere. A missing GroupTool row is a refusal at step 5 of
-- the authorization check, so absence would silently 403 a lead.
INSERT INTO "GroupTool" ("groupId", "toolId", "isEnabled", "updatedAt")
SELECT grp."id", tool."id", true, CURRENT_TIMESTAMP
FROM "Group" grp
CROSS JOIN "Tool" tool
WHERE tool."key" = 'CALENDAR'
ON CONFLICT ("groupId", "toolId") DO NOTHING;

-- Read only, and only on the two roles that are the floor of their branch:
-- TEAM_MEMBER sits under everyone on the team and MENTOR observes everything,
-- so between them the permission reaches every role through RoleHierarchy
-- without a row per role. Granting it to LEAD as well would be dead data.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", true, false, false, false
FROM "Role" role
JOIN "Tool" tool ON tool."key" = 'CALENDAR'
WHERE role."key" IN ('TEAM_MEMBER', 'MENTOR')
ON CONFLICT ("roleId", "toolId") DO NOTHING;

-- SYSTEM_ADMIN has to be granted explicitly here.
--
-- 20260829090200 gave it every tool with a CROSS JOIN over "Tool", but that
-- migration has already run: it covered the thirteen tools that existed then
-- and knows nothing about one added afterwards. Any future tool needs this same
-- four lines, or the admin quietly loses the module it is supposed to
-- administer.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", true, true, true, true
FROM "Role" role
JOIN "Tool" tool ON tool."key" = 'CALENDAR'
WHERE role."key" = 'SYSTEM_ADMIN'
ON CONFLICT ("roleId", "toolId") DO NOTHING;
