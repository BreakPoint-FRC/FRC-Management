import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";
import { createAccountsService } from "../accounts/accounts.service";
import { createGroupsService } from "../groups/groups.service";
import { createRolesService } from "../roles/roles.service";
import { createSetupService } from "../setup/setup.service";

const TEAM = "team-1";
const ACTOR = "account-admin";
const FULL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

function accountRow(id: string) {
  return {
    id,
    teamId: TEAM,
    email: "member@breakpoint.test",
    fullName: "Takim Uyesi",
    isActive: true,
    mustChangePassword: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    archivedAt: null,
    roles: [],
    memberships: [],
  };
}

describe("audit writes", () => {
  it("audits account creation and later role replacement without storing the password", async () => {
    const audit = vi.fn().mockResolvedValue({});
    let roleRows: Array<{ roleId: string; groupId: string | null }> = [];
    const tx = {
      account: { create: vi.fn(async () => ({ id: "account-new" })) },
      accountRole: {
        findMany: async () => roleRows,
        deleteMany: vi.fn(async () => {
          roleRows = [];
          return { count: 1 };
        }),
        createMany: vi.fn(async ({ data }: { data: typeof roleRows }) => {
          roleRows = data.map((entry) => ({
            roleId: entry.roleId,
            groupId: entry.groupId,
          }));
          return { count: data.length };
        }),
      },
      groupMembership: { upsert: vi.fn() },
      auditLog: { create: audit },
    };
    const prisma = {
      role: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id, name: id, placement: "TEAM_WIDE" })),
        count: async () => 0,
      },
      group: { count: async () => 0 },
      account: {
        findFirst: async () => ({ id: "account-new" }),
        findUniqueOrThrow: async () => accountRow("account-new"),
      },
      accountRole: { count: async () => 0 },
      roleHierarchy: { findMany: async () => [] },
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
    } as unknown as PrismaClient;
    const service = createAccountsService(prisma);
    const password = "CanaryPassword2026!";

    await service.create(
      TEAM,
      {
        email: "member@breakpoint.test",
        fullName: "Takim Uyesi",
        password,
        isActive: true,
        roles: [{ roleId: "role-member" }],
      },
      ACTOR
    );
    await service.replaceRoles(
      TEAM,
      "account-new",
      { roles: [{ roleId: "role-lead" }] },
      ACTOR
    );

    expect(audit.mock.calls.map((call) => call[0].data.action)).toEqual([
      "ACCOUNT_CREATED",
      "ACCOUNT_ROLES_REPLACED",
    ]);
    expect(audit.mock.calls[1]?.[0].data).toMatchObject({
      teamId: TEAM,
      actorId: ACTOR,
      entityId: "account-new",
      oldValue: [{ roleId: "role-member", groupId: null }],
      newValue: [{ roleId: "role-lead", groupId: null }],
    });
    const payload = JSON.stringify(audit.mock.calls);
    expect(payload).not.toContain(password);
    expect(payload).not.toMatch(/passwordHash|refreshToken|tokenHash/);
  });

  it("covers role create, update, permission, hierarchy and delete writes", async () => {
    const audit = vi.fn().mockResolvedValue({});
    let groupScopeIds = ["group-1"];
    let permissions: Array<{
      toolId: string;
      tool: { id: string; key: string; name: string };
      canRead: boolean;
      canCreate: boolean;
      canUpdate: boolean;
      canDelete: boolean;
    }> = [];
    let edges: Array<{ parentRoleId: string; childRoleId: string }> = [];
    const role = {
      id: "role-main",
      teamId: TEAM,
      key: "LEAD",
      name: "Lead",
      description: null,
      placement: "MANAGES_GROUP",
      isSystemRole: false,
      get groupScopes() {
        return groupScopeIds.map((groupId) => ({
          groupId,
          group: { id: groupId, name: groupId },
        }));
      },
      get permissions() {
        return permissions;
      },
      children: [],
      parents: [],
      _count: { accountRoles: 0 },
    };
    const createdRole = {
      ...role,
      id: "role-created",
      key: "SAFETY_CAPTAIN",
      name: "Safety Captain",
      placement: "TEAM_WIDE",
      groupScopes: [],
      permissions: [],
    };
    const roleApi = {
      findMany: async ({ where }: { where?: { id?: { in: string[] } } }) =>
        where?.id?.in?.map((id) => ({ id })) ?? [role],
      findFirst: async () => ({
        ...role,
        groupScopes: role.groupScopes.map((scope) => ({ ...scope })),
        permissions: role.permissions.map((entry) => ({ ...entry })),
      }),
      findUniqueOrThrow: async () => ({
        ...role,
        groupScopes: role.groupScopes.map((scope) => ({ ...scope })),
        permissions: role.permissions.map((entry) => ({ ...entry })),
      }),
      count: async () => 2,
      create: vi.fn(async () => createdRole),
      update: vi.fn(async ({ data }: { data: { placement?: string; name?: string } }) => {
        if (data.placement) role.placement = data.placement;
        if (data.name) role.name = data.name;
        return role;
      }),
      delete: vi.fn(),
    };
    const rolePermissionApi = {
      findMany: async () => permissions,
      deleteMany: vi.fn(async () => {
        permissions = [];
        return { count: 0 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ toolId: string } & typeof FULL> }) => {
          permissions = data.map((entry) => ({
            ...entry,
            tool: { id: entry.toolId, key: "TASKS", name: "Tasks" },
          }));
          return { count: data.length };
        }
      ),
    };
    const hierarchyApi = {
      findMany: async () => edges,
      create: vi.fn(async ({ data }: { data: (typeof edges)[number] }) => {
        edges.push(data);
        return data;
      }),
      delete: vi.fn(async () => {
        edges = [];
        return {};
      }),
    };
    const tx = {
      role: roleApi,
      rolePermission: rolePermissionApi,
      roleHierarchy: hierarchyApi,
      roleGroupScope: {
        deleteMany: vi.fn(async () => {
          groupScopeIds = [];
          return { count: 1 };
        }),
        createMany: vi.fn(),
      },
      accountRole: { updateMany: vi.fn() },
      auditLog: { create: audit },
    };
    const prisma = {
      role: roleApi,
      rolePermission: rolePermissionApi,
      roleHierarchy: hierarchyApi,
      group: { count: async () => 1 },
      tool: { findMany: async () => [{ id: "tool-tasks", key: "TASKS" }] },
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
    } as unknown as PrismaClient;
    const service = createRolesService(prisma);

    await service.create(
      TEAM,
      {
        key: "SAFETY_CAPTAIN",
        name: "Safety Captain",
        description: null,
        placement: "TEAM_WIDE",
        groupScopeIds: [],
      },
      ACTOR
    );
    await service.update(
      TEAM,
      role.id,
      { placement: "ABOVE_GROUPS", name: "Technical Director" },
      ACTOR
    );
    await service.replacePermissions(
      TEAM,
      role.id,
      { permissions: [{ tool: "TASKS", ...FULL }] },
      ACTOR
    );
    await service.linkRoles(TEAM, role.id, "role-child", ACTOR);
    await service.unlinkRoles(TEAM, role.id, "role-child", ACTOR);
    await service.remove(TEAM, role.id, ACTOR);

    expect(audit.mock.calls.map((call) => call[0].data.action)).toEqual([
      "ROLE_CREATED",
      "ROLE_UPDATED",
      "ROLE_PERMISSIONS_REPLACED",
      "ROLE_HIERARCHY_LINKED",
      "ROLE_HIERARCHY_UNLINKED",
      "ROLE_DELETED",
    ]);
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: ACTOR,
        action: "ROLE_PERMISSIONS_REPLACED",
        oldValue: [],
        newValue: [{ tool: "TASKS", ...FULL }],
      }),
    });
  });

  it("covers group creation, parent changes and tool replacement", async () => {
    const audit = vi.fn().mockResolvedValue({});
    let parentId: string | null = null;
    let tools: Array<{
      groupId: string;
      toolId: string;
      isEnabled: boolean;
      tool: { key: string };
    }> = [];
    const groupRow = (id: string) => ({
      id,
      parentId,
      name: id,
      description: null,
      isActive: true,
      tools,
      _count: { memberships: 0 },
    });
    const groupApi = {
      count: async () => 1,
      findMany: async () => [
        { id: "group-main", parentId },
        { id: "group-parent", parentId: null },
      ],
      findUniqueOrThrow: async () => ({ parentId }),
      create: vi.fn(async () => groupRow("group-created")),
      update: vi.fn(async ({ data }: { data: { parentId?: string | null } }) => {
        if (data.parentId !== undefined) parentId = data.parentId;
        return groupRow("group-main");
      }),
    };
    const groupToolApi = {
      findMany: async () => tools,
      deleteMany: vi.fn(async () => {
        tools = [];
        return { count: 0 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ groupId: string; toolId: string; isEnabled: boolean }> }) => {
          tools = data.map((entry) => ({ ...entry, tool: { key: "TASKS" } }));
          return { count: data.length };
        }
      ),
    };
    const tx = {
      group: groupApi,
      groupTool: groupToolApi,
      auditLog: { create: audit },
    };
    const prisma = {
      group: groupApi,
      groupTool: groupToolApi,
      tool: { findMany: async () => [{ id: "tool-tasks", key: "TASKS" }] },
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
    } as unknown as PrismaClient;
    const service = createGroupsService(prisma);

    await service.create(
      TEAM,
      { name: "New Group", description: null, parentId: null, isActive: true },
      ACTOR
    );
    await service.update(TEAM, "group-main", { parentId: "group-parent" }, ACTOR);
    await service.replaceTools(
      TEAM,
      "group-main",
      { tools: [{ tool: "TASKS", isEnabled: true }] },
      ACTOR
    );

    expect(audit.mock.calls.map((call) => call[0].data.action)).toEqual([
      "GROUP_CREATED",
      "GROUP_PARENT_CHANGED",
      "GROUP_TOOLS_REPLACED",
    ]);
    expect(audit.mock.calls[1]?.[0].data).toMatchObject({
      actorId: ACTOR,
      oldValue: { parentId: null },
      newValue: { parentId: "group-parent" },
    });
  });

  it("emits one summary record when the setup template is applied", async () => {
    const audit = vi.fn().mockResolvedValue({});
    let sequence = 0;
    const tx = {
      role: { create: vi.fn(async () => ({ id: `role-${++sequence}` })) },
      rolePermission: { createMany: vi.fn() },
      roleHierarchy: { createMany: vi.fn() },
      auditLog: { create: audit },
    };
    const prisma = {
      role: { count: async () => 0 },
      group: { findMany: async () => [{ id: "group-root", parentId: null }] },
      tool: { findMany: async () => [{ id: "tool-tasks", key: "TASKS" }] },
      $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
    } as unknown as PrismaClient;

    await createSetupService(prisma).applyTemplate(TEAM, ACTOR);

    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId: TEAM,
        actorId: ACTOR,
        entityType: "TEAM",
        entityId: TEAM,
        action: "TEMPLATE_APPLIED",
        newValue: expect.objectContaining({ template: "FRC_ROLE_TEMPLATE_V1" }),
      }),
    });
  });

  it("commits neither the mutation nor its audit row when the transaction fails", async () => {
    const committed = {
      roles: [{ roleId: "role-member", groupId: null as string | null }],
      audits: [] as unknown[],
    };
    const prisma = {
      role: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id, name: id, placement: "TEAM_WIDE" })),
        count: async () => 0,
      },
      account: {
        findFirst: async () => ({ id: "account-1" }),
        findUniqueOrThrow: async () => accountRow("account-1"),
      },
      accountRole: { count: async () => 0 },
      $transaction: async (work: (tx: unknown) => unknown) => {
        let stagedRoles = [...committed.roles];
        const stagedAudits: unknown[] = [];
        const tx = {
          accountRole: {
            findMany: async () => stagedRoles,
            deleteMany: async () => {
              stagedRoles = [];
            },
            createMany: async ({ data }: { data: typeof stagedRoles }) => {
              stagedRoles = data.map((entry) => ({
                roleId: entry.roleId,
                groupId: entry.groupId,
              }));
            },
          },
          groupMembership: { upsert: vi.fn() },
          auditLog: { create: async (entry: unknown) => stagedAudits.push(entry) },
        };
        await (work as (client: typeof tx) => unknown)(tx);
        // Simulate a database commit failure. Staged state must not escape.
        throw new Error("commit failed");
      },
    } as unknown as PrismaClient;

    await expect(
      createAccountsService(prisma).replaceRoles(
        TEAM,
        "account-1",
        { roles: [{ roleId: "role-lead" }] },
        ACTOR
      )
    ).rejects.toThrow(/commit failed/);
    expect(committed.roles).toEqual([{ roleId: "role-member", groupId: null }]);
    expect(committed.audits).toEqual([]);
  });
});

describe("GET /audit-log", () => {
  const account = {
    id: ACTOR,
    teamId: TEAM,
    email: "admin@breakpoint.test",
    fullName: "Team Admin",
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    team: { isActive: true },
    roles: [
      {
        groupId: null,
        role: { id: "role-admin", placement: "TEAM_WIDE", groupScopes: [] },
      },
    ],
    memberships: [],
  };

  function routeApp(canRead = true, authenticatedAccount: unknown = account) {
    const auditCreate = vi.fn().mockResolvedValue({});
    const rows = [
      {
        id: "audit-own",
        teamId: TEAM,
        actorId: ACTOR,
        entityType: "ROLE",
        entityId: "role-1",
        action: "ROLE_PERMISSIONS_REPLACED",
        oldValue: [],
        newValue: [{ tool: "TASKS", ...FULL }],
        createdAt: new Date("2026-09-05T10:00:00.000Z"),
        actor: { id: ACTOR, fullName: "Team Admin" },
      },
      {
        id: "audit-other",
        teamId: "team-2",
        actorId: "other-admin",
        entityType: "ROLE",
        entityId: "role-1",
        action: "ROLE_UPDATED",
        oldValue: {},
        newValue: {},
        createdAt: new Date("2026-09-05T11:00:00.000Z"),
        actor: { id: "other-admin", fullName: "Other Admin" },
      },
    ];
    const permissionRows: unknown[] = [];
    const stub = {
      $disconnect: vi.fn(),
      account: { findUnique: async () => authenticatedAccount },
      group: { findMany: async () => [] },
      groupTool: { findMany: async () => [] },
      roleHierarchy: { findMany: async () => [] },
      role: { findFirst: async () => ({ id: "role-1" }) },
      tool: {
        findUnique: async () => ({ id: "tool-audit", isActive: true }),
        findMany: async () => [{ id: "tool-tasks", key: "TASKS" }],
      },
      rolePermission: {
        findMany: async ({ where }: { where: { roleId?: unknown } }) =>
          typeof where.roleId === "string"
            ? permissionRows
            : canRead
              ? [FULL]
              : [],
        deleteMany: vi.fn(async () => {
          permissionRows.length = 0;
        }),
        createMany: vi.fn(async () => ({})),
      },
      auditLog: {
        findMany: vi.fn(async ({ where }: { where: { teamId: string } }) =>
          rows.filter((row) => row.teamId === where.teamId)
        ),
        count: vi.fn(async ({ where }: { where: { teamId: string } }) =>
          rows.filter((row) => row.teamId === where.teamId).length
        ),
        create: auditCreate,
      },
    };
    const prisma = Object.assign(stub, {
      $transaction: async (work: unknown) =>
        Array.isArray(work)
          ? Promise.all(work)
          : (work as (tx: typeof stub) => unknown)(stub),
    }) as unknown as PrismaClient;
    return { app: buildApp({ prisma }), auditCreate, auditFind: stub.auditLog.findMany };
  }

  const auth = (app: ReturnType<typeof buildApp>) => ({
    authorization: `Bearer ${app.jwt.sign({ sub: ACTOR })}`,
  });

  it("filters every read by the authenticated account's team and supports all filters", async () => {
    const { app, auditFind } = routeApp();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/audit-log?entityType=ROLE&entityId=role-1&from=2026-09-01&to=2026-09-06&page=1&pageSize=10",
      headers: auth(app),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      items: [{ id: "audit-own", actor: { id: ACTOR, fullName: "Team Admin" } }],
    });
    expect(auditFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          teamId: TEAM,
          entityType: "ROLE",
          entityId: "role-1",
          createdAt: {
            gte: new Date("2026-09-01"),
            lte: new Date("2026-09-06"),
          },
        }),
      })
    );
    await app.close();
  });

  it("requires AUDIT_LOG read and exposes no client-callable write route", async () => {
    const denied = routeApp(false);
    await denied.app.ready();
    expect(
      (await denied.app.inject({ method: "GET", url: "/audit-log", headers: auth(denied.app) }))
        .statusCode
    ).toBe(403);
    await denied.app.close();

    const allowed = routeApp();
    await allowed.app.ready();
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      const response = await allowed.app.inject({
        method,
        url: "/audit-log",
        headers: auth(allowed.app),
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
    expect(allowed.auditCreate).not.toHaveBeenCalled();
    await allowed.app.close();
  });

  it("does not let a platform administrator select a team's audit history", async () => {
    const platformAccount = {
      ...account,
      teamId: null,
      team: null,
      roles: [
        {
          groupId: null,
          role: { id: "role-system", placement: "TEAM_WIDE", groupScopes: [] },
        },
      ],
    };
    const { app } = routeApp(true, platformAccount);
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/audit-log",
      headers: auth(app),
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("takes the audit actor from the session, never from the request body", async () => {
    const { app, auditCreate } = routeApp();
    await app.ready();

    const response = await app.inject({
      method: "PUT",
      url: "/roles/role-1/permissions",
      headers: auth(app),
      payload: {
        actorId: "attacker-controlled",
        permissions: [{ tool: "TASKS", ...FULL }],
      },
    });

    expect(response.statusCode).toBe(204);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: ACTOR,
        action: "ROLE_PERMISSIONS_REPLACED",
      }),
    });
    expect(auditCreate).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: "attacker-controlled" }),
    });
    await app.close();
  });
});
