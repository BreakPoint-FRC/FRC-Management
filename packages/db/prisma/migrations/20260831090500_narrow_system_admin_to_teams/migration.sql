-- Takes every module but TEAMS away from the platform system admin.
--
-- 20260831090300 granted it all of them, by analogy with the single-team
-- SYSTEM_ADMIN it replaced. That was wrong for the role it had become: a
-- platform admin belongs to no team, and every team-scoped route refuses an
-- account with no team (requireTeam in apps/api/src/lib/tenant.ts). So the
-- grants authorized nothing. What they did do is fill the sidebar with
-- Gorevler, Toplantilar, Finans and the rest -- eleven links to pages that
-- would answer 403, on the one account that has no use for any of them.
--
-- Permissions decide what the UI draws (GET /auth/me), so a grant that cannot
-- be exercised is not harmless: it is a menu of dead ends.
--
-- TEAMS is the whole job. Opening a team, archiving one, and creating the
-- administrator who will run it are all gated on it, and nothing else the
-- platform admin does needs a second module.

DELETE FROM "RolePermission" perm
WHERE perm."roleId" = 'rl00000000000000systemadmin'
  AND NOT EXISTS (
    SELECT 1 FROM "Tool" tool WHERE tool."id" = perm."toolId" AND tool."key" = 'TEAMS'
  );

-- Note for whoever adds the next tool: it needs a TEAM_ADMIN grant, not a
-- SYSTEM_ADMIN one. That reverses what 20260831090300 said, and this is the
-- migration that reversed it.
--
-- TEAM_ADMIN roles for teams created from now on pick up new tools on their
-- own, because teams.service builds the matrix from a live query. The ones that
-- already exist do not, so a new tool still needs a row for them:
--
--   INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
--   SELECT gen_random_uuid()::text, role."id", tool."id", true, true, true, true
--   FROM "Role" role
--   JOIN "Tool" tool ON tool."key" = '<NEW_TOOL>'
--   WHERE role."key" = 'TEAM_ADMIN'
--   ON CONFLICT ("roleId", "toolId") DO NOTHING;
