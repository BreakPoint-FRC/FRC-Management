-- The authorization tables. Structure only -- the rows that make the system
-- usable (roles, tools, the permission matrix) land in the next migration,
-- together with the data migrated off MemberRole.
--
-- Shape: Account holds Roles, a Role holds Permissions per Tool, a Group
-- decides which Tools it uses at all. See docs/authorization.md.

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'GROUP');

-- RenameEnum
-- The legacy Role enum has to move out of the way before a Role *table* can
-- exist: in Postgres a table also defines a composite type of the same name, so
-- `CREATE TABLE "Role"` collides with the existing `CREATE TYPE "Role"`.
-- Renamed rather than dropped, because the next migration still reads
-- MemberRole.role to backfill AccountRole.
ALTER TYPE "Role" RENAME TO "LegacyMemberPosition";

-- AlterTable
-- Group grows from a bare name into a department record.
ALTER TABLE "Group" ADD COLUMN "description" TEXT;
ALTER TABLE "Group" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Group" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Group" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Group" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "RoleScope" NOT NULL,
    "hierarchyLevel" INTEGER NOT NULL DEFAULT 100,
    "isSystemRole" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleHierarchy" (
    "parentRoleId" TEXT NOT NULL,
    "childRoleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleHierarchy_pkey" PRIMARY KEY ("parentRoleId","childRoleId")
);

-- CreateTable
CREATE TABLE "AccountRole" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "groupId" TEXT,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AccountRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupTool" (
    "groupId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupTool_pkey" PRIMARY KEY ("groupId","toolId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canCreate" BOOLEAN NOT NULL DEFAULT false,
    "canUpdate" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Group_isActive_idx" ON "Group"("isActive");
CREATE UNIQUE INDEX "GroupMembership_accountId_groupId_key" ON "GroupMembership"("accountId", "groupId");
CREATE INDEX "GroupMembership_groupId_idx" ON "GroupMembership"("groupId");
CREATE INDEX "GroupMembership_accountId_isActive_idx" ON "GroupMembership"("accountId", "isActive");
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");
CREATE INDEX "Role_scope_idx" ON "Role"("scope");
CREATE INDEX "Role_hierarchyLevel_idx" ON "Role"("hierarchyLevel");
CREATE INDEX "RoleHierarchy_childRoleId_idx" ON "RoleHierarchy"("childRoleId");

-- Postgres treats NULLs as distinct in a unique index, so this does not stop a
-- second (account, SYSTEM_ADMIN, null) row. Prisma can express neither
-- NULLS NOT DISTINCT nor a partial index, and adding one by hand would put the
-- database permanently out of sync with schema.prisma. The gap is closed on the
-- write path instead: roles are only ever replaced as a whole set.
CREATE UNIQUE INDEX "AccountRole_accountId_roleId_groupId_key" ON "AccountRole"("accountId", "roleId", "groupId");
CREATE INDEX "AccountRole_accountId_isActive_idx" ON "AccountRole"("accountId", "isActive");
CREATE INDEX "AccountRole_roleId_idx" ON "AccountRole"("roleId");
CREATE INDEX "AccountRole_groupId_idx" ON "AccountRole"("groupId");
CREATE INDEX "AccountRole_assignedById_idx" ON "AccountRole"("assignedById");
CREATE UNIQUE INDEX "Tool_key_key" ON "Tool"("key");
CREATE INDEX "Tool_isActive_idx" ON "Tool"("isActive");
CREATE INDEX "GroupTool_toolId_idx" ON "GroupTool"("toolId");
CREATE UNIQUE INDEX "RolePermission_roleId_toolId_key" ON "RolePermission"("roleId", "toolId");
CREATE INDEX "RolePermission_toolId_idx" ON "RolePermission"("toolId");

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleHierarchy" ADD CONSTRAINT "RoleHierarchy_parentRoleId_fkey" FOREIGN KEY ("parentRoleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleHierarchy" ADD CONSTRAINT "RoleHierarchy_childRoleId_fkey" FOREIGN KEY ("childRoleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountRole" ADD CONSTRAINT "AccountRole_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountRole" ADD CONSTRAINT "AccountRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountRole" ADD CONSTRAINT "AccountRole_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountRole" ADD CONSTRAINT "AccountRole_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GroupTool" ADD CONSTRAINT "GroupTool_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupTool" ADD CONSTRAINT "GroupTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
