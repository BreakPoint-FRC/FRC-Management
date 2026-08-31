import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import type { PermissionSet, RolePlacement } from "@breakpoint/types";

import { authorize } from "./authorize";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "./http-errors";

// The authorization rules are the part of this system most expensive to get
// wrong, and they are pure logic over a handful of rows -- so they are tested
// against a stub rather than a database. Every case below is one step of the
// order in docs/authorization.md.

const TOOL_ID = "tool-tasks";
const TEAM = "team-1";

// Teknik
//   +- Mekanik
//        +- Tasarim
// Medya
//
// Deliberately three levels deep on one branch: scoping a role to Teknik has to
// reach Tasarim, and a tool enabled on Teknik has to be inherited by it.
const GROUPS = [
  { id: "teknik", parentId: null },
  { id: "mekanik", parentId: "teknik" },
  { id: "tasarim", parentId: "mekanik" },
  { id: "medya", parentId: null },
];

const NONE: PermissionSet = {
  canRead: false,
  canCreate: false,
  canUpdate: false,
  canDelete: false,
};
const ALL: PermissionSet = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };
const READ_ONLY: PermissionSet = { ...NONE, canRead: true };

interface HeldRole {
  groupId?: string | null;
  role: { id: string; placement: RolePlacement; groupScopes?: Array<{ groupId: string }> };
}

interface Scenario {
  account?: {
    teamId?: string | null;
    team?: { isActive: boolean } | null;
    isActive?: boolean;
    archivedAt?: Date | null;
    roles?: HeldRole[];
    memberships?: Array<{ groupId: string }>;
  } | null;
  groups?: Array<{ id: string; parentId: string | null }>;
  tool?: { id: string; isActive: boolean } | null;
  hierarchy?: Array<{ parentRoleId: string; childRoleId: string }>;
  /** groupId -> whether that group states the tool on or off. */
  groupTools?: Record<string, boolean>;
  /** roleId -> what that role grants directly on the tool. */
  permissions?: Record<string, PermissionSet>;
}

function stubPrisma(scenario: Scenario): PrismaClient {
  const {
    account = {
      teamId: TEAM,
      team: { isActive: true },
      isActive: true,
      archivedAt: null,
      roles: [],
      memberships: [],
    },
    groups = GROUPS,
    tool = { id: TOOL_ID, isActive: true },
    hierarchy = [],
    groupTools = {},
    permissions = {},
  } = scenario;

  const filled = account && {
    teamId: TEAM,
    team: { isActive: true },
    isActive: true,
    archivedAt: null,
    memberships: [],
    ...account,
    roles: (account.roles ?? []).map((entry) => ({
      groupId: entry.groupId ?? null,
      role: { groupScopes: [], ...entry.role },
    })),
  };

  return {
    account: { findUnique: async () => filled },
    group: { findMany: async () => groups },
    tool: { findUnique: async () => tool },
    roleHierarchy: { findMany: async () => hierarchy },
    groupTool: {
      findMany: async () =>
        Object.entries(groupTools).map(([groupId, isEnabled]) => ({
          groupId,
          toolId: TOOL_ID,
          isEnabled,
        })),
    },
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

/** Every group in the tree uses the tool, for cases that are not about tools. */
const ALL_TOOLS_ON = { teknik: true, mekanik: true, tasarim: true, medya: true };

describe("authorize", () => {
  describe("the account itself", () => {
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

  describe("a tool switched off system-wide", () => {
    it("blocks everyone, including a team admin", async () => {
      const prisma = stubPrisma({
        tool: { id: TOOL_ID, isActive: false },
        account: { roles: [{ role: { id: "role-admin", placement: "TEAM_WIDE" } }] },
        permissions: { "role-admin": ALL },
      });
      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("tenancy", () => {
    it("answers 404 for a group belonging to another team", async () => {
      // 404 rather than 403: a 403 would confirm the id exists, which is the
      // one thing a caller from another team must not be able to learn.
      const prisma = stubPrisma({
        account: { roles: [{ role: { id: "role-admin", placement: "TEAM_WIDE" } }] },
        permissions: { "role-admin": ALL },
        groupTools: ALL_TOOLS_ON,
      });

      await expect(
        authorize(prisma, { ...request, groupId: "group-of-another-team" })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("TEAM_WIDE - the bypass", () => {
    it("allows a team-wide role with no membership and no GroupTool row", async () => {
      // The point of the bypass: a team admin is not a member of every
      // department and must not have to be. It is the only placement that also
      // skips the tool check.
      const prisma = stubPrisma({
        account: { roles: [{ role: { id: "role-admin", placement: "TEAM_WIDE" } }] },
        permissions: { "role-admin": ALL },
        groupTools: {},
      });

      await expect(authorize(prisma, { ...request, groupId: "mekanik" })).resolves.toMatchObject({
        canUpdate: true,
      });
    });

    it("does not let a team-wide read permission authorize a write", async () => {
      const prisma = stubPrisma({
        account: { roles: [{ role: { id: "role-mentor", placement: "TEAM_WIDE" } }] },
        permissions: { "role-mentor": READ_ONLY },
      });

      await expect(authorize(prisma, request)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(authorize(prisma, { ...request, action: "read" })).resolves.toMatchObject({
        canRead: true,
      });
    });
  });

  describe("EXTERNAL - attached to the team, outside its groups", () => {
    it("authorizes a request that names no group", async () => {
      const prisma = stubPrisma({
        account: { roles: [{ role: { id: "role-mentor", placement: "EXTERNAL" } }] },
        permissions: { "role-mentor": ALL },
      });

      await expect(authorize(prisma, request)).resolves.toMatchObject({ canUpdate: true });
    });

    it("reaches records inside a group on its own grant", async () => {
      // A mentor who reads everything reads the tasks of every department too,
      // so what EXTERNAL is granted applies team-wide. What it does not do is
      // hold authority *in* a group -- see the next case.
      const prisma = stubPrisma({
        account: { roles: [{ role: { id: "role-mentor", placement: "EXTERNAL" } }] },
        permissions: { "role-mentor": ALL },
        groupTools: ALL_TOOLS_ON,
      });

      await expect(
        authorize(prisma, { ...request, groupId: "mekanik" })
      ).resolves.toMatchObject({ canUpdate: true });
    });

    it("never combines with an in-group role to reach something neither grants", async () => {
      // EXTERNAL covers no group, so it is not in the set merged for a group.
      // A mentor with read plus a member with create does not add up to update
      // in Mekanik -- which is the difference between EXTERNAL and TEAM_WIDE.
      const prisma = stubPrisma({
        account: {
          roles: [
            { role: { id: "role-mentor", placement: "EXTERNAL" } },
            { groupId: "mekanik", role: { id: "role-member", placement: "IN_GROUP" } },
          ],
          memberships: [{ groupId: "mekanik" }],
        },
        permissions: {
          "role-mentor": READ_ONLY,
          "role-member": { ...NONE, canCreate: true },
        },
        groupTools: ALL_TOOLS_ON,
      });

      await expect(
        authorize(prisma, { ...request, groupId: "mekanik" })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("no group on the request", () => {
    it("refuses when only a group-scoped role would have allowed it", async () => {
      const prisma = stubPrisma({
        account: {
          roles: [{ groupId: "mekanik", role: { id: "role-member", placement: "IN_GROUP" } }],
          memberships: [{ groupId: "mekanik" }],
        },
        permissions: { "role-member": ALL },
      });

      await expect(authorize(prisma, request)).rejects.toThrow(/takim genelinde yetkiniz yok/);
    });
  });
});

// The heart of what this rewrite added: a role can sit above *some* groups
// rather than all of them or exactly one.
describe("scoped placements", () => {
  const director = (placement: RolePlacement, ...scopes: string[]) => ({
    roles: [
      {
        role: {
          id: "role-director",
          placement,
          groupScopes: scopes.map((groupId) => ({ groupId })),
        },
      },
    ],
  });

  it("ABOVE_GROUPS reaches a group it is scoped to", async () => {
    const prisma = stubPrisma({
      account: director("ABOVE_GROUPS", "teknik"),
      permissions: { "role-director": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(authorize(prisma, { ...request, groupId: "teknik" })).resolves.toMatchObject({
      canUpdate: true,
    });
  });

  it("ABOVE_GROUPS reaches a subgroup three levels down", async () => {
    // RoleGroupScope stores the roots of the authority, not its closure:
    // scoping to Teknik covers Tasarim without anyone writing that row, and a
    // subgroup added tomorrow is covered the day it appears.
    const prisma = stubPrisma({
      account: director("ABOVE_GROUPS", "teknik"),
      permissions: { "role-director": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(authorize(prisma, { ...request, groupId: "tasarim" })).resolves.toMatchObject({
      canUpdate: true,
    });
  });

  it("ABOVE_GROUPS does not reach a group it was not scoped to", async () => {
    // This is the whole reason the old GLOBAL scope was not enough. A technical
    // director runs the engineering departments and has no business in Medya.
    const prisma = stubPrisma({
      account: director("ABOVE_GROUPS", "teknik"),
      permissions: { "role-director": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(
      authorize(prisma, { ...request, groupId: "medya" })
    ).rejects.toThrow(/bu grup icin yetkiniz yok/i);
  });

  it("ABOVE_GROUPS cannot authorize a request with no group", async () => {
    // Authority over some departments is not authority over the team, and a
    // record belonging to no department is a team-wide record.
    const prisma = stubPrisma({
      account: director("ABOVE_GROUPS", "teknik"),
      permissions: { "role-director": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(authorize(prisma, request)).rejects.toThrow(/takim genelinde yetkiniz yok/);
  });

  it("MANAGES_GROUP needs no membership in the group it runs", async () => {
    const prisma = stubPrisma({
      account: director("MANAGES_GROUP", "mekanik"),
      permissions: { "role-director": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(authorize(prisma, { ...request, groupId: "mekanik" })).resolves.toMatchObject({
      canUpdate: true,
    });
  });

  it("a scoped role is still stopped by a tool the group does not use", async () => {
    // Unlike TEAM_WIDE. This is why a Yazilim lead cannot open Finance even
    // though they run a department.
    const prisma = stubPrisma({
      account: director("MANAGES_GROUP", "mekanik"),
      permissions: { "role-director": ALL },
      groupTools: { mekanik: false },
    });

    await expect(
      authorize(prisma, { ...request, groupId: "mekanik" })
    ).rejects.toThrow(/bu grup icin kapali/);
  });
});

describe("IN_GROUP - membership still matters", () => {
  const member = {
    roles: [{ groupId: "mekanik", role: { id: "role-member", placement: "IN_GROUP" as const } }],
  };

  it("refuses someone who is not in the group", async () => {
    const prisma = stubPrisma({
      account: { ...member, memberships: [] },
      permissions: { "role-member": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(
      authorize(prisma, { ...request, groupId: "mekanik" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows a member of the group", async () => {
    const prisma = stubPrisma({
      account: { ...member, memberships: [{ groupId: "mekanik" }] },
      permissions: { "role-member": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(authorize(prisma, { ...request, groupId: "mekanik" })).resolves.toMatchObject({
      canUpdate: true,
    });
  });

  it("ignores a role held in a different group", async () => {
    // Being a Mekanik member says nothing about Medya, which is the whole
    // reason AccountRole carries a groupId.
    const prisma = stubPrisma({
      account: { ...member, memberships: [{ groupId: "mekanik" }, { groupId: "medya" }] },
      permissions: { "role-member": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(
      authorize(prisma, { ...request, groupId: "medya" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("does not follow the group tree downward", async () => {
    // A Mekanik member is not thereby a Tasarim member. Only the scoped
    // placements inherit down the tree; membership is the group it names.
    const prisma = stubPrisma({
      account: { ...member, memberships: [{ groupId: "mekanik" }] },
      permissions: { "role-member": ALL },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(
      authorize(prisma, { ...request, groupId: "tasarim" })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("tools inherit down the group tree", () => {
  const lead = {
    roles: [
      {
        role: {
          id: "role-lead",
          placement: "MANAGES_GROUP" as const,
          groupScopes: [{ groupId: "teknik" }],
        },
      },
    ],
  };

  it("a row on an ancestor applies to a group that states nothing", async () => {
    const prisma = stubPrisma({
      account: lead,
      permissions: { "role-lead": ALL },
      groupTools: { teknik: true },
    });

    await expect(authorize(prisma, { ...request, groupId: "tasarim" })).resolves.toMatchObject({
      canUpdate: true,
    });
  });

  it("the nearest ancestor wins, so a subgroup can switch it back off", async () => {
    const prisma = stubPrisma({
      account: lead,
      permissions: { "role-lead": ALL },
      groupTools: { teknik: true, mekanik: false },
    });

    await expect(
      authorize(prisma, { ...request, groupId: "tasarim" })
    ).rejects.toThrow(/bu grup icin kapali/);
  });

  it("no row anywhere up the chain reads as off", async () => {
    // Absence is the safe reading: a group created tomorrow must not silently
    // acquire Finance because nobody has said no yet.
    const prisma = stubPrisma({
      account: lead,
      permissions: { "role-lead": ALL },
      groupTools: {},
    });

    await expect(
      authorize(prisma, { ...request, groupId: "tasarim" })
    ).rejects.toThrow(/bu grup icin kapali/);
  });
});

describe("role hierarchy inheritance", () => {
  // An edge is "parent is above child", and a parent inherits the permissions
  // of its descendants. These tests pin the direction: swapping it would hand
  // every member their lead's permissions, and nothing else would notice.
  const hierarchy = [
    { parentRoleId: "role-team-lead", childRoleId: "role-lead" },
    { parentRoleId: "role-lead", childRoleId: "role-member" },
  ];

  it("gives a parent role what its descendants can do", async () => {
    const prisma = stubPrisma({
      account: { roles: [{ role: { id: "role-team-lead", placement: "TEAM_WIDE" } }] },
      hierarchy,
      // Granted two levels down, on the member role only.
      permissions: { "role-member": ALL },
    });

    await expect(authorize(prisma, request)).resolves.toMatchObject({ canUpdate: true });
  });

  it("is transitive: an edge to an edge is still inherited", async () => {
    // 1 above 2 and 2 above 3 puts 1 above 3, with nothing storing that. It is
    // the reason there is no rank number on Role -- the walk does not stop at
    // the first hop, so the closure never has to be maintained.
    const prisma = stubPrisma({
      account: { roles: [{ role: { id: "role-team-lead", placement: "TEAM_WIDE" } }] },
      hierarchy,
      permissions: { "role-lead": NONE, "role-member": READ_ONLY },
    });

    await expect(authorize(prisma, { ...request, action: "read" })).resolves.toMatchObject({
      canRead: true,
    });
  });

  it("does not give a child role what its parent can do", async () => {
    const prisma = stubPrisma({
      account: { roles: [{ role: { id: "role-member", placement: "TEAM_WIDE" } }] },
      hierarchy,
      permissions: { "role-team-lead": ALL },
    });

    await expect(authorize(prisma, request)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("terminates on a cycle instead of hanging", async () => {
    // roles.service rejects cycles on the write path. This is the guard for one
    // that got in anyway -- a hung request would take the whole API down, where
    // a wrong answer would only be wrong.
    const prisma = stubPrisma({
      account: { roles: [{ role: { id: "role-a", placement: "TEAM_WIDE" } }] },
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
    // A team-wide read plus an in-group create is one permission set. Holding
    // two roles must never subtract from either.
    const prisma = stubPrisma({
      account: {
        roles: [
          { role: { id: "role-observer", placement: "TEAM_WIDE" } },
          { groupId: "mekanik", role: { id: "role-member", placement: "IN_GROUP" } },
        ],
        memberships: [{ groupId: "mekanik" }],
      },
      permissions: {
        "role-observer": READ_ONLY,
        "role-member": { ...NONE, canCreate: true },
      },
      groupTools: ALL_TOOLS_ON,
    });

    const permissions = await authorize(prisma, {
      ...request,
      action: "create",
      groupId: "mekanik",
    });

    expect(permissions).toMatchObject({ canRead: true, canCreate: true, canDelete: false });
  });

  it("adds a scoped role to an in-group one for the same group", async () => {
    const prisma = stubPrisma({
      account: {
        roles: [
          {
            role: {
              id: "role-director",
              placement: "ABOVE_GROUPS",
              groupScopes: [{ groupId: "teknik" }],
            },
          },
          { groupId: "mekanik", role: { id: "role-member", placement: "IN_GROUP" } },
        ],
        memberships: [{ groupId: "mekanik" }],
      },
      permissions: {
        "role-director": { ...NONE, canDelete: true },
        "role-member": { ...NONE, canCreate: true },
      },
      groupTools: ALL_TOOLS_ON,
    });

    await expect(
      authorize(prisma, { ...request, action: "delete", groupId: "mekanik" })
    ).resolves.toMatchObject({ canCreate: true, canDelete: true });
  });
});
