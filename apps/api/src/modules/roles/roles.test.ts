import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";
import { ConflictError } from "../../lib/http-errors";
import { updateRoleSchema } from "./roles.schema";
import { createRolesService } from "./roles.service";

// Every service call is scoped to a team now. The id itself is arbitrary; what
// the tests pin is that it reaches the query.
const TEAM = "team-1";

// The hierarchy is a graph the database cannot police: Prisma can express
// neither a CHECK for the self-edge nor a recursive assertion for a cycle, and
// adding one by hand desynchronises schema.prisma permanently. So the write
// path is the only guard, and these are the tests of it.

const EDGES = [
  { parentRoleId: "team-lead", childRoleId: "lead" },
  { parentRoleId: "lead", childRoleId: "member" },
];

function stubPrisma(overrides: Record<string, unknown> = {}) {
  return {
    role: {
      // linkRoles filters on teamId as well: platform roles are readable but
      // not wireable, or a team could inherit the permissions of SYSTEM_ADMIN.
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id })),
      count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length,
    },
    roleHierarchy: {
      findMany: async () => EDGES,
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe("role hierarchy", () => {
  it("refuses an edge from a role to itself", async () => {
    const service = createRolesService(stubPrisma());

    await expect(service.linkRoles(TEAM, "lead", "lead")).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses an edge that closes a cycle", async () => {
    // team-lead -> lead -> member already exists. Adding member -> team-lead
    // would close the loop, and permission resolution walks these edges on
    // every authorized request.
    const service = createRolesService(stubPrisma());

    await expect(service.linkRoles(TEAM, "member", "team-lead")).rejects.toThrow(/dongu/);
  });

  it("refuses a longer cycle, not just a direct one", async () => {
    const prisma = stubPrisma({
      roleHierarchy: {
        findMany: async () => [
          { parentRoleId: "a", childRoleId: "b" },
          { parentRoleId: "b", childRoleId: "c" },
          { parentRoleId: "c", childRoleId: "d" },
        ],
        create: vi.fn(),
      },
    });
    const service = createRolesService(prisma);

    await expect(service.linkRoles(TEAM, "d", "a")).rejects.toThrow(/dongu/);
  });

  it("allows an edge that only deepens the tree", async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = createRolesService(
      stubPrisma({ roleHierarchy: { findMany: async () => EDGES, create } })
    );

    await service.linkRoles(TEAM, "member", "intern");

    expect(create).toHaveBeenCalledWith({
      data: { parentRoleId: "member", childRoleId: "intern" },
    });
  });

  it("allows a second parent for the same child", async () => {
    // A diamond is not a cycle: both the president and the vice-president sit
    // above the team lead, and that has to be expressible.
    const create = vi.fn().mockResolvedValue({});
    const service = createRolesService(
      stubPrisma({ roleHierarchy: { findMany: async () => EDGES, create } })
    );

    await service.linkRoles(TEAM, "president", "lead");

    expect(create).toHaveBeenCalled();
  });
});

describe("deleting a role", () => {
  const stubForDelete = (role: unknown) =>
    ({
      // findFirst, not findUnique: the team is half the identity now.
      role: { findFirst: async () => role, delete: vi.fn() },
    }) as unknown as PrismaClient;

  it("refuses a system role", async () => {
    const service = createRolesService(
      stubForDelete({ isSystemRole: true, name: "Takim Yoneticisi", _count: { accountRoles: 0 } })
    );

    await expect(service.remove(TEAM, "system-admin")).rejects.toThrow(/Sistem rolleri silinemez/);
  });

  it("refuses a role that is still assigned, naming the count", async () => {
    // The foreign key would stop this anyway, but as a P2003 that reads
    // "Referenced record does not exist" -- which describes the opposite of
    // what happened.
    const service = createRolesService(
      stubForDelete({ isSystemRole: false, name: "Arsiv Sorumlusu", _count: { accountRoles: 3 } })
    );

    await expect(service.remove(TEAM, "role-x")).rejects.toThrow(/3 hesaba atanmis/);
  });

  it("deletes a role nothing depends on", async () => {
    const remove = vi.fn().mockResolvedValue({});
    const prisma = {
      role: {
        findFirst: async () => ({
          isSystemRole: false,
          name: "Kullanilmayan",
          _count: { accountRoles: 0 },
        }),
        delete: remove,
      },
    } as unknown as PrismaClient;

    await createRolesService(prisma).remove(TEAM, "role-unused");

    expect(remove).toHaveBeenCalledWith({ where: { id: "role-unused" } });
  });
});

describe("updating role placement scopes", () => {
  function roleRow(placement: string, scopeIds: string[]) {
    return {
      id: "role-1",
      teamId: TEAM,
      key: "LEAD",
      name: "Lead",
      description: null,
      placement,
      isSystemRole: false,
      groupScopes: scopeIds.map((groupId) => ({ group: { id: groupId, name: groupId } })),
      permissions: [],
      children: [],
      parents: [],
      _count: { accountRoles: 0 },
    };
  }

  function updateStub(existingPlacement: string, existingScopeIds: string[]) {
    const roleUpdate = vi.fn().mockResolvedValue({});
    const scopeDelete = vi.fn().mockResolvedValue({ count: existingScopeIds.length });
    const scopeCreate = vi.fn().mockResolvedValue({ count: 0 });
    const assignmentUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        role: { update: roleUpdate },
        roleGroupScope: { deleteMany: scopeDelete, createMany: scopeCreate },
        accountRole: { updateMany: assignmentUpdate },
      })
    );
    const prisma = {
      role: {
        findFirst: async () => ({
          id: "role-1",
          placement: existingPlacement,
          groupScopes: existingScopeIds.map((groupId) => ({ groupId })),
        }),
        findUniqueOrThrow: async () => roleRow(existingPlacement, existingScopeIds),
      },
      group: { count: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length },
      roleHierarchy: { findMany: async () => [] },
      $transaction: transaction,
    } as unknown as PrismaClient;

    return { prisma, roleUpdate, scopeDelete, scopeCreate, assignmentUpdate, transaction };
  }

  it("allows an omitted scope list through schema validation", () => {
    expect(updateRoleSchema.safeParse({ placement: "ABOVE_GROUPS" }).success).toBe(true);
  });

  it("preserves stored scopes between placements that use them", async () => {
    const stub = updateStub("MANAGES_GROUP", ["group-1"]);

    await createRolesService(stub.prisma).update(TEAM, "role-1", {
      placement: "ABOVE_GROUPS",
    });

    expect(stub.scopeDelete).not.toHaveBeenCalled();
    expect(stub.scopeCreate).not.toHaveBeenCalled();
    expect(stub.assignmentUpdate).toHaveBeenCalledWith({
      where: { roleId: "role-1" },
      data: { groupId: null },
    });
  });

  it("clears stored scopes when moving to a placement that forbids them", async () => {
    const stub = updateStub("MANAGES_GROUP", ["group-1"]);

    await createRolesService(stub.prisma).update(TEAM, "role-1", {
      placement: "TEAM_WIDE",
    });

    expect(stub.scopeDelete).toHaveBeenCalledWith({ where: { roleId: "role-1" } });
    expect(stub.scopeCreate).not.toHaveBeenCalled();
  });

  it("rejects a required placement when neither stored nor submitted scopes exist", async () => {
    const stub = updateStub("TEAM_WIDE", []);

    await expect(
      createRolesService(stub.prisma).update(TEAM, "role-1", {
        placement: "MANAGES_GROUP",
      })
    ).rejects.toBeInstanceOf(ConflictError);

    expect(stub.transaction).not.toHaveBeenCalled();
  });

  it("rejects an explicitly non-empty scope list for a team-wide placement", async () => {
    const stub = updateStub("MANAGES_GROUP", ["group-1"]);

    await expect(
      createRolesService(stub.prisma).update(TEAM, "role-1", {
        placement: "TEAM_WIDE",
        groupScopeIds: ["group-1"],
      })
    ).rejects.toBeInstanceOf(ConflictError);

    expect(stub.transaction).not.toHaveBeenCalled();
  });
});

describe("granting a platform-only tool to a team role", () => {
  // The hole this closes: authorize()'s TEAM_WIDE bypass reads the *placement*
  // of a role, which says nothing about whose role it is. A team admin who
  // wrote themselves a TEAM_WIDE role granting TEAMS passed every check and
  // opened teams on the platform. requirePlatform on /teams is the guarantee;
  // this is the half that keeps the row from being written at all.

  const NONE = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };

  function permissionStub() {
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = vi.fn(async (operations: unknown[]) => Promise.all(operations));
    const prisma = {
      role: { findFirst: async () => ({ id: "role-1" }) },
      tool: {
        findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.map((key) => ({ id: `tool-${key.toLowerCase()}`, key })),
      },
      rolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany },
      $transaction: transaction,
    } as unknown as PrismaClient;

    return { prisma, createMany, transaction };
  }

  for (const flag of ["canRead", "canCreate", "canUpdate", "canDelete"] as const) {
    it(`refuses a TEAMS grant carrying ${flag}, before writing anything`, async () => {
      const stub = permissionStub();

      await expect(
        createRolesService(stub.prisma).replacePermissions(TEAM, "role-1", {
          permissions: [
            { tool: "TASKS", ...NONE, canRead: true },
            { tool: "TEAMS", ...NONE, [flag]: true },
          ],
        })
      ).rejects.toBeInstanceOf(ConflictError);

      expect(stub.transaction).not.toHaveBeenCalled();
    });
  }

  it("accepts an all-false TEAMS row while another tool changes", async () => {
    // The regression this guards. permissionsPayload() sends every tool on
    // every save, so an ordinary role edit always carries a TEAMS row -- four
    // falses, but present. Refusing the row rather than the flag would break
    // every save in the app.
    const stub = permissionStub();

    await createRolesService(stub.prisma).replacePermissions(TEAM, "role-1", {
      permissions: [
        { tool: "TASKS", ...NONE, canRead: true, canUpdate: true },
        { tool: "TEAMS", ...NONE },
      ],
    });

    expect(stub.transaction).toHaveBeenCalledOnce();
    expect(stub.createMany).toHaveBeenCalledWith({
      data: [
        {
          roleId: "role-1",
          toolId: "tool-tasks",
          canRead: true,
          canCreate: false,
          canUpdate: true,
          canDelete: false,
        },
        {
          roleId: "role-1",
          toolId: "tool-teams",
          canRead: false,
          canCreate: false,
          canUpdate: false,
          canDelete: false,
        },
      ],
    });
  });
});

describe("PUT /roles/:id/permissions platform boundary", () => {
  const NONE = { canRead: false, canCreate: false, canUpdate: false, canDelete: false };
  const FULL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };
  const ACCOUNT = {
    id: "account-1",
    teamId: TEAM,
    email: "ada@breakpoint.test",
    fullName: "Ada Yilmaz",
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    team: { isActive: true },
    roles: [
      {
        groupId: null,
        role: {
          id: "role-admin",
          placement: "TEAM_WIDE",
          groupScopes: [],
        },
      },
    ],
    memberships: [],
  };

  function routeApp() {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const transaction = vi.fn(async (operations: unknown[]) => Promise.all(operations));
    const prisma = {
      $disconnect: vi.fn(),
      $transaction: transaction,
      account: { findUnique: async () => ACCOUNT },
      group: { findMany: async () => [] },
      groupTool: { findMany: async () => [] },
      roleHierarchy: { findMany: async () => [] },
      role: { findFirst: async () => ({ id: "role-1" }) },
      tool: {
        // authorize reads one tool by key; the service resolves the submitted
        // matrix to ids only after the platform-only validation has passed.
        findUnique: async () => ({ id: "tool-permissions", isActive: true }),
        findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.map((key) => ({ id: `tool-${key.toLowerCase()}`, key })),
      },
      rolePermission: {
        findMany: async () => [FULL],
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany,
      },
    } as unknown as PrismaClient;

    return { app: buildApp({ prisma }), createMany, transaction };
  }

  async function replacePermissions(
    app: ReturnType<typeof buildApp>,
    permissions: Array<{ tool: "TASKS" | "TEAMS" } & typeof NONE>
  ) {
    await app.ready();
    return app.inject({
      method: "PUT",
      url: "/roles/role-1/permissions",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ACCOUNT.id })}` },
      payload: { permissions },
    });
  }

  it("returns 409 when a team role is granted TEAMS", async () => {
    const stub = routeApp();

    const response = await replacePermissions(stub.app, [
      { tool: "TASKS", ...NONE, canRead: true },
      { tool: "TEAMS", ...NONE, canCreate: true },
    ]);

    expect(response.statusCode).toBe(409);
    expect(stub.transaction).not.toHaveBeenCalled();
    await stub.app.close();
  });

  it("returns 204 when TEAMS is all false and another tool changes", async () => {
    const stub = routeApp();

    const response = await replacePermissions(stub.app, [
      { tool: "TASKS", ...NONE, canRead: true, canUpdate: true },
      { tool: "TEAMS", ...NONE },
    ]);

    expect(response.statusCode).toBe(204);
    expect(stub.transaction).toHaveBeenCalledOnce();
    expect(stub.createMany).toHaveBeenCalledOnce();
    await stub.app.close();
  });
});
