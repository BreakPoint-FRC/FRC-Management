import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import type { PermissionSet } from "@breakpoint/types";

import { authorize } from "./authorize";
import { ForbiddenError, UnauthorizedError } from "./http-errors";

// The authorization rules are the part of this system most expensive to get
// wrong, and they are pure logic over a handful of rows -- so they are tested
// against a stub rather than a database. Every case below is one step of the
// order in docs/authorization.md.

const TOOL_ID = "tool-tasks";

const NONE: PermissionSet = {
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canDelete: false,
};
const ALL: PermissionSet = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };
const READ_ONLY: PermissionSet = { ...NONE, canRead: true };

interface Scenario {
  account?: {
    isActive?: boolean;
    archivedAt?: Date | null;
    roles?: Array<{ groupId: string | null; role: { id: string; scope: "GLOBAL" | "GROUP" } }>;
  } | null;
  tool?: { id: string; isActive: boolean } | null;
  hierarchy?: Array<{ parentRoleId: string; childRoleId: string }>;
  membership?: { isActive: boolean } | null;
  groupTool?: { isEnabled: boolean } | null;
  /** roleId -> what that role grants directly on the tool. */
  permissions?: Record<string, PermissionSet>;
}

function stubPrisma(scenario: Scenario): PrismaClient {
  const {
    account = { isActive: true, archivedAt: null, roles: [] },
    tool = { id: TOOL_ID, isActive: true },
    hierarchy = [],
    membership = null,
    groupTool = null,
    permissions = {},
  } = scenario;

  return {
    account: {
      findUnique: async () =>
        account && { isActive: true, archivedAt: null, roles: [], ...account },
    },
    tool: { findUnique: async () => tool },
    roleHierarchy: { findMany: async () => hierarchy },
    groupMembership: { findUnique: async () => membership },
    groupTool: { findUnique: async () => groupTool },
    rolePermission: {
      findMany: async ({ where }: { where: { roleId: { in: string[] } } }) =>
        where.roleId.in.map((roleId) => permissions[roleId]).filter(Boolean),
    },
  } as unknown as PrismaClient;
}

const request = {
  accountId: "account-1",
  tool: "TASKS",
  action: "update",
} as const;

describe("authorize", () => {
  describe("step 1 - the account itself", () => {
    it("rejects an unknown account with 401", async () => {
      await expect(authorize(stubPrisma({ account: null }), request)).rejects.toBeInstanceOf(
        UnauthorizedError
      );
    });

    it("rejects a deactivated account with 401, not 403", async () => {
      // 401 rather than 403 on purpose: the problem is the identity, so the
      // client should stop reusing the token rather than retry.
      const prisma = stubPrisma({ account: { isActive: false } });
      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("rejects an archived account even while isActive is still true", async () => {
      const prisma = stubPrisma({
        account: { isActive: true, archivedAt: new Date("2026-03-01") },
      });
      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  describe("step 2 - a tool switched off system-wide", () => {
    it("blocks everyone, including a global admin", async () => {
      const prisma = stubPrisma({
        tool: { id: TOOL_ID, isActive: false },
        account: { roles: [{ groupId: null, role: { id: "role-admin", scope: "GLOBAL" } }] },
        permissions: { "role-admin": ALL },
      });
      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("step 2 - the GLOBAL bypass", () => {
    it("allows a global role without any group membership", async () => {
      // The point of the bypass: a system admin is not a member of every
      // department and must not have to be.
      const prisma = stubPrisma({
        account: { roles: [{ groupId: null, role: { id: "role-admin", scope: "GLOBAL" } }] },
        permissions: { "role-admin": ALL },
        membership: null,
        groupTool: null,
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-programming" })
      ).resolves.toMatchObject({ canUpdate: true });
    });

    it("does not let a global read permission authorize a write", async () => {
      const prisma = stubPrisma({
        account: { roles: [{ groupId: null, role: { id: "role-mentor", scope: "GLOBAL" } }] },
        permissions: { "role-mentor": READ_ONLY },
      });

      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(authorize(prisma, { ...request, action: "read" })).resolves.toMatchObject({
        canRead: true,
      });
    });
  });

  describe("step 3 - no group on the request", () => {
    it("refuses when only a group role would have allowed it", async () => {
      // A group-scoped role says nothing about a request that names no group.
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "group-programming", role: { id: "role-lead", scope: "GROUP" } }],
        },
        permissions: { "role-lead": ALL },
      });

      await expect(authorize(prisma, request)).rejects.toThrow(
        /takim genelinde yetkiniz yok/
      );
    });
  });

  describe("step 4 - group membership", () => {
    it("refuses someone who is not in the group", async () => {
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "group-programming", role: { id: "role-lead", scope: "GROUP" } }],
        },
        permissions: { "role-lead": ALL },
        membership: null,
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-programming" })
      ).rejects.toThrow(/uyesi degilsiniz/);
    });

    it("refuses someone whose membership has been ended", async () => {
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "group-programming", role: { id: "role-lead", scope: "GROUP" } }],
        },
        permissions: { "role-lead": ALL },
        membership: { isActive: false },
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-programming" })
      ).rejects.toThrow(/uyesi degilsiniz/);
    });
  });

  describe("step 5 - the group's tools", () => {
    it("refuses when the department does not use the tool", async () => {
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "group-programming", role: { id: "role-lead", scope: "GROUP" } }],
        },
        permissions: { "role-lead": ALL },
        membership: { isActive: true },
        groupTool: { isEnabled: false },
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-programming" })
      ).rejects.toThrow(/bu grup icin kapali/);
    });

    it("treats a missing GroupTool row as disabled", async () => {
      // Absence is the safe reading: a group created tomorrow must not silently
      // acquire Finance.
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "group-programming", role: { id: "role-lead", scope: "GROUP" } }],
        },
        permissions: { "role-lead": ALL },
        membership: { isActive: true },
        groupTool: null,
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-programming" })
      ).rejects.toThrow(/bu grup icin kapali/);
    });
  });

  describe("step 6 - roles held in that group", () => {
    const inProgramming = (roleId: string) => ({
      account: { roles: [{ groupId: "group-programming", role: { id: roleId, scope: "GROUP" as const } }] },
      membership: { isActive: true },
      groupTool: { isEnabled: true },
    });

    it("allows when the role grants the action", async () => {
      const prisma = stubPrisma({
        ...inProgramming("role-lead"),
        permissions: { "role-lead": ALL },
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-programming" })
      ).resolves.toMatchObject({ canUpdate: true });
    });

    it("refuses when the role grants everything but the action asked for", async () => {
      const prisma = stubPrisma({
        ...inProgramming("role-member"),
        permissions: { "role-member": { ...ALL, canDelete: false } },
      });

      await expect(
        authorize(prisma, { ...request, action: "delete", groupId: "group-programming" })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("ignores a role held in a different group", async () => {
      // Being Programming Lead says nothing about Business, which is the whole
      // reason AccountRole carries a groupId.
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "group-programming", role: { id: "role-lead", scope: "GROUP" } }],
        },
        permissions: { "role-lead": ALL },
        membership: { isActive: true },
        groupTool: { isEnabled: true },
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-business" })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("role hierarchy inheritance", () => {
    // An edge is "parent is above child", and a parent inherits its
    // descendants' permissions. These two tests pin the direction: swapping it
    // would hand every member their lead's permissions, and nothing else in the
    // suite would notice.
    const hierarchy = [
      { parentRoleId: "role-team-lead", childRoleId: "role-lead" },
      { parentRoleId: "role-lead", childRoleId: "role-member" },
    ];

    it("gives a parent role what its descendants can do", async () => {
      const prisma = stubPrisma({
        account: { roles: [{ groupId: null, role: { id: "role-team-lead", scope: "GLOBAL" } }] },
        hierarchy,
        // Granted two levels down, on MEMBER only.
        permissions: { "role-member": ALL },
      });

      await expect(authorize(prisma, request)).resolves.toMatchObject({ canUpdate: true });
    });

    it("does not give a child role what its parent can do", async () => {
      const prisma = stubPrisma({
        account: { roles: [{ groupId: null, role: { id: "role-member", scope: "GLOBAL" } }] },
        hierarchy,
        permissions: { "role-team-lead": ALL },
      });

      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("terminates on a cycle instead of hanging", async () => {
      // roles.service rejects cycles on the write path. This is the guard for
      // one that got in anyway -- a hung request would take the whole API down,
      // where a wrong answer would only be wrong.
      const prisma = stubPrisma({
        account: { roles: [{ groupId: null, role: { id: "role-a", scope: "GLOBAL" } }] },
        hierarchy: [
          { parentRoleId: "role-a", childRoleId: "role-b" },
          { parentRoleId: "role-b", childRoleId: "role-a" },
        ],
        permissions: { "role-b": ALL },
      });

      await expect(authorize(prisma, request)).resolves.toMatchObject({ canUpdate: true });
    });
  });

  describe("holding several roles", () => {
    it("merges permissions rather than letting one role mask another", async () => {
      // A mentor's team-wide read plus a member's in-group create is one
      // permission set. Holding two roles must never subtract from either.
      const prisma = stubPrisma({
        account: {
          roles: [
            { groupId: null, role: { id: "role-mentor", scope: "GLOBAL" } },
            { groupId: "group-programming", role: { id: "role-member", scope: "GROUP" } },
          ],
        },
        permissions: {
          "role-mentor": READ_ONLY,
          "role-member": { ...NONE, canCreate: true },
        },
        membership: { isActive: true },
        groupTool: { isEnabled: true },
      });

      const permissions = await authorize(prisma, {
        ...request,
        action: "create",
        groupId: "group-programming",
      });

      expect(permissions).toMatchObject({ canRead: true, canCreate: true, canDelete: false });
    });
  });
});
