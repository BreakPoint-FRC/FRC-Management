-- The global tool catalogue is maintained by a platform account. Identity and
-- authority remain separate: requirePlatform keeps team accounts out of the
-- mutation routes, while this grant lets the fixed platform SYSTEM_ADMIN pass
-- their ordinary TOOLS permission checks.
--
-- Update every flag on conflict so reapplying the intent also repairs a row
-- whose permissions were narrowed manually or by an earlier deployment.

INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, 'rl00000000000000systemadmin', tool."id", true, true, true, true
FROM "Tool" tool
WHERE tool."key" = 'TOOLS'
ON CONFLICT ("roleId", "toolId") DO UPDATE
SET "canRead" = true,
    "canCreate" = true,
    "canUpdate" = true,
    "canDelete" = true;
