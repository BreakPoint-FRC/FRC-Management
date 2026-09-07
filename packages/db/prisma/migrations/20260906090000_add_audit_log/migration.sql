-- Create the append-only, team-scoped security audit trail. There are no API
-- mutation routes for this table; entries are written by the configuration
-- transaction they describe.
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_teamId_createdAt_idx" ON "AuditLog"("teamId", "createdAt");
CREATE INDEX "AuditLog_teamId_entityType_entityId_createdAt_idx"
ON "AuditLog"("teamId", "entityType", "entityId", "createdAt");
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit history contains account, group, tool, permission and setup changes,
-- not only roles. A separate permission lets a security reviewer read it
-- without also receiving role-management authority.
INSERT INTO "Tool" ("id", "key", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'AUDIT_LOG',
  'Denetim Kaydi',
  'Guvenlik acisindan onemli rol, izin ve hiyerarsi degisikliklerinin gecmisi.',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

-- Existing team administrators may read their own team's log. Platform
-- administrators have no team context and cannot call this endpoint; granting
-- them this tool would imply cross-team access that the API deliberately does
-- not provide. No create/update/delete flag is granted because audit mutations
-- are deliberately not client-callable.
INSERT INTO "RolePermission" ("id", "roleId", "toolId", "canRead", "canCreate", "canUpdate", "canDelete")
SELECT gen_random_uuid()::text, role."id", tool."id", true, false, false, false
FROM "Role" role
CROSS JOIN "Tool" tool
WHERE tool."key" = 'AUDIT_LOG'
  AND role."key" = 'TEAM_ADMIN'
ON CONFLICT ("roleId", "toolId") DO UPDATE
SET "canRead" = true,
    "canCreate" = false,
    "canUpdate" = false,
    "canDelete" = false;
