-- The role model moves from two enums to two tables.
--
-- The old model was a position (Role) times a subteam (Subteam), argued for in
-- docs/roles.md. Both axes survive here, they are just rows now: "Yazilim Lead"
-- was (LEAD, SOFTWARE) and becomes Role(LEAD, scope GROUP) assigned in
-- Group(Programming). Nothing about the model is lost -- it stops needing a
-- migration to add a department.
--
-- This migration also seeds the roles, tools and permission matrix. That is
-- deliberately not left to prisma/seed.ts: without these rows nobody can be
-- authorized for anything, so a freshly deployed database would be inert. The
-- seed adds team and demo data on top; this adds the configuration the system
-- cannot run without.

-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------

-- The two existing free-form groups become the first two departments. "Software"
-- is renamed rather than replaced, so the tasks already pointing at it keep
-- their group.
UPDATE "Group" SET "name" = 'Programming', "description" = 'Yazilim' WHERE "name" = 'Software';
UPDATE "Group" SET "description" = 'Mekanik' WHERE "name" = 'Mechanical' AND "description" IS NULL;

INSERT INTO "Group" ("id", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'Programming', 'Yazilim',   true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Mechanical',  'Mekanik',   true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Electrical',  'Elektronik', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Business',    'Business',  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Media',       'Medya / PR', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Strategy',    'Strateji',  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

-- Keys are English to match the rest of the codebase; name is what the team
-- reads, so it is Turkish.
--
-- LEAD and MEMBER are GROUP scope: they say nothing on their own and mean
-- "lead of / member of the group this was assigned in". Everything else is
-- team-wide. TEAM_MEMBER is the GLOBAL floor -- the old (MEMBER, null) row,
-- someone on the team whose department is not settled yet.
INSERT INTO "Role" ("id", "key", "name", "description", "scope", "hierarchyLevel", "isSystemRole", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'SYSTEM_ADMIN',       'Sistem Yoneticisi',  'Tum sistemde tam yetki.',                      'GLOBAL',  0, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PRESIDENT',          'Baskan',             'Takim baskani.',                               'GLOBAL', 10, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'VICE_PRESIDENT',     'Baskan Yardimcisi',  'Takim baskan yardimcisi.',                     'GLOBAL', 20, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TEAM_LEAD',          'Takim Lideri',       'Tum alt takimlarin uzerinde.',                 'GLOBAL', 25, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TECHNICAL_DIRECTOR', 'Teknik Sorumlu',     'Teknik alt takimlardan sorumlu.',              'GLOBAL', 30, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SOCIAL_DIRECTOR',    'Sosyal Sorumlu',     'Medya, sponsor ve sosyal islerden sorumlu.',   'GLOBAL', 40, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MENTOR',             'Mentor',             'Her seyi gorur, yazmaz.',                      'GLOBAL', 50, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'LEAD',               'Lead',               'Atandigi grubun lideri.',                      'GROUP',  60, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MEMBER',             'Uye',                'Atandigi grubun uyesi.',                       'GROUP',  70, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TEAM_MEMBER',        'Takim Uyesi',        'Takimda, alt takimi henuz belli degil.',       'GLOBAL', 80, true,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- An edge means "parent is above child", and permission resolution reads it as
-- a parent inheriting the union of its descendants' permissions. So Team Lead
-- gets everything Lead has, which gets everything Member has -- exactly the
-- tree in the spec, at one role per level instead of one per level per
-- department.
INSERT INTO "RoleHierarchy" ("parentRoleId", "childRoleId", "createdAt")
SELECT parent."id", child."id", CURRENT_TIMESTAMP
FROM (VALUES
  ('PRESIDENT',          'TEAM_LEAD'),
  ('VICE_PRESIDENT',     'TEAM_LEAD'),
  ('TEAM_LEAD',          'LEAD'),
  ('TECHNICAL_DIRECTOR', 'LEAD'),
  ('SOCIAL_DIRECTOR',    'LEAD'),
  ('LEAD',               'MEMBER'),
  ('MEMBER',             'TEAM_MEMBER')
) AS edge(parent_key, child_key)
JOIN "Role" parent ON parent."key" = edge.parent_key
JOIN "Role" child  ON child."key"  = edge.child_key
ON CONFLICT ("parentRoleId", "childRoleId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tools
-- ---------------------------------------------------------------------------

-- The seven feature modules plus the six administrative ones. Admin actions are
-- tools too, which is what makes "Admin" a role with permissions rather than a
-- separate entity with a hard-coded bypass.
INSERT INTO "Tool" ("id", "key", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'TASKS',       'Gorevler',    'Gorev yonetimi.',                    true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TODO',        'Yapilacaklar', 'Gorevlerin filtrelenmis gorunumu.', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TASK_LOGS',   'Gorev Kayitlari', 'Gorev degisiklik gecmisi.',      true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'GANTT',       'Gantt',       'Zaman cizelgesi.',                   true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MEETINGS',    'Toplantilar', 'Toplanti ve yoklama.',               true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'FINANCE',     'Finans',      'Gelir ve gider takibi.',             true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SPONSORS',    'Sponsorlar',  'Sponsor ve firma yonetimi.',         true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ACCOUNTS',    'Hesaplar',    'Uye hesaplari.',                     true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'GROUPS',      'Gruplar',     'Departmanlar.',                      true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ROLES',       'Roller',      'Rol ve rol hiyerarsisi.',            true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TOOLS',       'Moduller',    'Modul tanimlari.',                   true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PERMISSIONS', 'Yetkiler',    'Rol izin matrisi.',                  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SEASONS',     'Sezonlar',    'Sezon yonetimi.',                    true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Permission matrix
-- ---------------------------------------------------------------------------

-- Only what each role grants *directly*. Inherited permissions are not written
-- here -- they are resolved from RoleHierarchy at request time, so a change to
-- the tree does not need a data migration to follow it.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", grant_row.can_read, grant_row.can_create, grant_row.can_update, grant_row.can_delete
FROM (VALUES
  -- The floor: anyone on the team can see the work, and nothing more.
  ('TEAM_MEMBER',        'TASKS',       true,  false, false, false),
  ('TEAM_MEMBER',        'TODO',        true,  false, false, false),
  ('TEAM_MEMBER',        'MEETINGS',    true,  false, false, false),
  ('TEAM_MEMBER',        'GANTT',       true,  false, false, false),
  ('TEAM_MEMBER',        'TASK_LOGS',   true,  false, false, false),

  -- In their own department a member can pick up and move work, but not delete
  -- it. Reads come from TEAM_MEMBER through the hierarchy.
  ('MEMBER',             'TASKS',       true,  true,  true,  false),

  -- A lead runs the department: full control of its work, meetings and
  -- timeline, and can see who is in it.
  ('LEAD',               'TASKS',       true,  true,  true,  true),
  ('LEAD',               'MEETINGS',    true,  true,  true,  true),
  ('LEAD',               'GANTT',       true,  true,  true,  true),
  ('LEAD',               'ACCOUNTS',    true,  false, false, false),

  -- Above the departments: the roster and the season, plus visibility of money.
  ('TEAM_LEAD',          'ACCOUNTS',    true,  false, true,  false),
  ('TEAM_LEAD',          'GROUPS',      true,  false, false, false),
  ('TEAM_LEAD',          'SEASONS',     true,  false, false, false),
  ('TEAM_LEAD',          'FINANCE',     true,  false, false, false),

  ('SOCIAL_DIRECTOR',    'SPONSORS',    true,  true,  true,  false),

  -- Mentors observe. Reading everything and writing nothing is the point.
  ('MENTOR',             'TASKS',       true,  false, false, false),
  ('MENTOR',             'TODO',        true,  false, false, false),
  ('MENTOR',             'TASK_LOGS',   true,  false, false, false),
  ('MENTOR',             'GANTT',       true,  false, false, false),
  ('MENTOR',             'MEETINGS',    true,  false, false, false),
  ('MENTOR',             'FINANCE',     true,  false, false, false),
  ('MENTOR',             'SPONSORS',    true,  false, false, false),
  ('MENTOR',             'ACCOUNTS',    true,  false, false, false),

  ('PRESIDENT',          'FINANCE',     true,  true,  true,  true),
  ('PRESIDENT',          'SPONSORS',    true,  true,  true,  true),
  ('PRESIDENT',          'SEASONS',     true,  true,  true,  false),
  ('PRESIDENT',          'ACCOUNTS',    true,  true,  true,  false),
  ('PRESIDENT',          'GROUPS',      true,  true,  true,  false),

  ('VICE_PRESIDENT',     'SPONSORS',    true,  true,  true,  false),
  ('VICE_PRESIDENT',     'FINANCE',     true,  true,  false, false)
) AS grant_row(role_key, tool_key, can_read, can_create, can_update, can_delete)
JOIN "Role" role ON role."key" = grant_row.role_key
JOIN "Tool" tool ON tool."key" = grant_row.tool_key
ON CONFLICT ("roleId", "toolId") DO NOTHING;

-- SYSTEM_ADMIN gets every tool outright rather than by inheritance. Its power
-- must not depend on the shape of a tree that an admin can edit.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", true, true, true, true
FROM "Role" role
CROSS JOIN "Tool" tool
WHERE role."key" = 'SYSTEM_ADMIN'
ON CONFLICT ("roleId", "toolId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Which tools each department uses
-- ---------------------------------------------------------------------------

-- A row missing here means the tool is off for that group -- see authorize().
-- Only the feature modules get rows; the administrative tools are GLOBAL-scope
-- and are never reached through a group.
INSERT INTO "GroupTool" ("groupId", "toolId", "isEnabled", "updatedAt")
SELECT grp."id", tool."id", true, CURRENT_TIMESTAMP
FROM "Group" grp
CROSS JOIN "Tool" tool
WHERE tool."key" IN ('TASKS', 'TODO', 'TASK_LOGS', 'GANTT', 'MEETINGS')
ON CONFLICT ("groupId", "toolId") DO NOTHING;

-- Money and sponsors are not every department's business.
INSERT INTO "GroupTool" ("groupId", "toolId", "isEnabled", "updatedAt")
SELECT grp."id", tool."id", true, CURRENT_TIMESTAMP
FROM "Group" grp
JOIN "Tool" tool ON tool."key" = 'FINANCE'
WHERE grp."name" = 'Business'
ON CONFLICT ("groupId", "toolId") DO NOTHING;

INSERT INTO "GroupTool" ("groupId", "toolId", "isEnabled", "updatedAt")
SELECT grp."id", tool."id", true, CURRENT_TIMESTAMP
FROM "Group" grp
JOIN "Tool" tool ON tool."key" = 'SPONSORS'
WHERE grp."name" IN ('Business', 'Media')
ON CONFLICT ("groupId", "toolId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill: MemberRole -> AccountRole
-- ---------------------------------------------------------------------------

-- Runs before the DROP below. Prisma would emit the drop first and take every
-- role with it.
--
-- (LEAD, SOFTWARE)      -> Role LEAD        in Group Programming
-- (MEMBER, BUSINESS)    -> Role MEMBER      in Group Business
-- (MEMBER, null)        -> Role TEAM_MEMBER, no group
-- (ADMIN, null)         -> Role SYSTEM_ADMIN, no group
-- every other position  -> the role of the same key, no group
INSERT INTO "AccountRole" ("id", "accountId", "roleId", "groupId", "assignedAt", "isActive")
SELECT
  gen_random_uuid()::text,
  legacy."memberId",
  role."id",
  grp."id",
  CURRENT_TIMESTAMP,
  true
FROM "MemberRole" legacy
JOIN "Role" role ON role."key" = CASE
    WHEN legacy."role"::text = 'ADMIN' THEN 'SYSTEM_ADMIN'
    WHEN legacy."role"::text = 'MEMBER' AND legacy."subteam" IS NULL THEN 'TEAM_MEMBER'
    ELSE legacy."role"::text
  END
LEFT JOIN "Group" grp ON grp."name" = CASE legacy."subteam"::text
    WHEN 'SOFTWARE'    THEN 'Programming'
    WHEN 'MECHANICAL'  THEN 'Mechanical'
    WHEN 'ELECTRONICS' THEN 'Electrical'
    WHEN 'PR'          THEN 'Media'
    WHEN 'BUSINESS'    THEN 'Business'
  END
ON CONFLICT ("accountId", "roleId", "groupId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill: GroupMember -> GroupMembership
-- ---------------------------------------------------------------------------

INSERT INTO "GroupMembership" ("id", "accountId", "groupId", "joinedAt", "isActive")
SELECT gen_random_uuid()::text, legacy."memberId", legacy."groupId", CURRENT_TIMESTAMP, true
FROM "GroupMember" legacy
ON CONFLICT ("accountId", "groupId") DO NOTHING;

-- Holding a group-scoped role has to imply membership of that group, or step 4
-- of the authorization check would turn a department lead away from their own
-- department. The old model left this implicit; this one states it.
INSERT INTO "GroupMembership" ("id", "accountId", "groupId", "joinedAt", "isActive")
SELECT gen_random_uuid()::text, pair."accountId", pair."groupId", CURRENT_TIMESTAMP, true
FROM (
  SELECT DISTINCT "accountId", "groupId" FROM "AccountRole" WHERE "groupId" IS NOT NULL
) AS pair
ON CONFLICT ("accountId", "groupId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Retire the old model
-- ---------------------------------------------------------------------------

-- DropTable
DROP TABLE "MemberRole";
DROP TABLE "GroupMember";

-- DropEnum
DROP TYPE "LegacyMemberPosition";
DROP TYPE "Subteam";
