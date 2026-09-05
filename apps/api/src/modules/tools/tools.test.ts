import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";

const FULL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

const BASE_TOOLS = [
  {
    id: "tool-tools",
    key: "TOOLS",
    name: "Moduller",
    description: "Global modul katalogu",
    isActive: true,
  },
  {
    id: "tool-groups",
    key: "GROUPS",
    name: "Gruplar",
    description: null,
    isActive: true,
  },
  {
    id: "tool-tasks",
    key: "TASKS",
    name: "Gorevler",
    description: null,
    isActive: true,
  },
  {
    id: "tool-teams",
    key: "TEAMS",
    name: "Takimlar",
    description: null,
    isActive: true,
  },
];

const GROUP = {
  id: "group-software",
  parentId: null,
  name: "Yazilim",
  description: null,
  isActive: true,
};

/**
 * One in-memory Prisma surface shared by authorization and the three services
 * exercised here. Keeping its rows stateful makes these route tests cover the
 * actual Fastify handlers and service writes rather than isolated mocks.
 */
function statefulApp(options: {
  platform?: boolean;
  grants: readonly string[];
  setupStage?: string;
}) {
  const teamId = options.platform ? null : "team-1";
  const roleId = options.platform ? "rl00000000000000systemadmin" : "role-team-admin";
  const tools = BASE_TOOLS.map((tool) => ({ ...tool }));
  const groupTools: Array<{ groupId: string; toolId: string; isEnabled: boolean }> = [];
  let setupStage = options.setupStage ?? "TOOLS";
  let createdToolSequence = 0;

  const account = {
    id: "account-1",
    email: options.platform ? "system@breakpoint.test" : "ada@breakpoint.test",
    fullName: options.platform ? "System Admin" : "Ada Yilmaz",
    teamId,
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    team: teamId === null ? null : { isActive: true },
    memberships: [],
    roles: [
      {
        groupId: null,
        isActive: true,
        role: {
          id: roleId,
          key: options.platform ? "SYSTEM_ADMIN" : "TEAM_ADMIN",
          placement: "TEAM_WIDE",
          groupScopes: [],
        },
      },
    ],
  };

  const decoratedGroupTools = () =>
    groupTools.map((entry) => ({
      ...entry,
      tool: { key: tools.find((tool) => tool.id === entry.toolId)?.key },
    }));

  const decoratedGroups = () => [
    {
      ...GROUP,
      tools: decoratedGroupTools().filter((entry) => entry.groupId === GROUP.id),
      _count: { memberships: 0 },
    },
  ];

  const createTool = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    createdToolSequence += 1;
    const row = {
      id: `tool-created-${createdToolSequence}`,
      key: data.key as string,
      name: data.name as string,
      description: (data.description as string | null | undefined) ?? null,
      isActive: (data.isActive as boolean | undefined) ?? true,
    };
    tools.push(row);
    return row;
  });

  const updateTool = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = tools.find((tool) => tool.id === where.id);
      if (!row) throw new Error("tool not found in test state");
      Object.assign(row, data);
      return row;
    }
  );

  const transaction = async (work: unknown) => {
    if (Array.isArray(work)) return Promise.all(work);
    return (work as (tx: PrismaClient) => unknown)(stub as unknown as PrismaClient);
  };

  const stub = {
    $disconnect: vi.fn(),
    $transaction: transaction,
    account: {
      findUnique: async () => account,
      count: async () => 1,
    },
    team: {
      findUnique: async () => ({
        id: "team-1",
        name: "Cekirdek",
        slug: "cekirdek",
        isActive: true,
        setupStage,
        setupCompletedAt: null,
      }),
      update: vi.fn(async ({ data }: { data: { setupStage?: string } }) => {
        if (data.setupStage) setupStage = data.setupStage;
        return { id: "team-1", setupStage, setupCompletedAt: null };
      }),
    },
    tool: {
      findUnique: async ({ where }: { where: { id?: string; key?: string } }) =>
        tools.find((tool) =>
          where.id !== undefined ? tool.id === where.id : tool.key === where.key
        ) ?? null,
      findMany: async ({ where }: { where?: { key?: { in?: string[] } } } = {}) => {
        const keys = where?.key?.in;
        return (keys ? tools.filter((tool) => keys.includes(tool.key)) : tools)
          .slice()
          .sort((a, b) => a.key.localeCompare(b.key));
      },
      create: createTool,
      update: updateTool,
    },
    group: {
      findMany: async () => decoratedGroups(),
      count: async ({ where }: { where?: { id?: string; teamId?: string } } = {}) =>
        where?.id && where.id !== GROUP.id ? 0 : 1,
    },
    groupTool: {
      findMany: async () => decoratedGroupTools(),
      count: async () => groupTools.length,
      deleteMany: vi.fn(async ({ where }: { where: { groupId: string } }) => {
        for (let index = groupTools.length - 1; index >= 0; index -= 1) {
          if (groupTools[index]?.groupId === where.groupId) groupTools.splice(index, 1);
        }
        return { count: 1 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ groupId: string; toolId: string; isEnabled: boolean }> }) => {
          groupTools.push(...data.map((entry) => ({ ...entry })));
          return { count: data.length };
        }
      ),
    },
    role: { count: async () => 0 },
    roleHierarchy: { findMany: async () => [] },
    rolePermission: {
      findMany: async ({ where }: { where: { roleId: { in: string[] }; toolId: string } }) => {
        const key = tools.find((tool) => tool.id === where.toolId)?.key;
        return where.roleId.in.includes(roleId) && key && options.grants.includes(key)
          ? [FULL]
          : [];
      },
      count: async () => 0,
    },
    season: { count: async () => 0 },
  };
  const prisma = stub as unknown as PrismaClient;

  return {
    app: buildApp({ prisma }),
    createTool,
    updateTool,
    groupTools,
    tools,
    stage: () => setupStage,
  };
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

async function inject(
  app: ReturnType<typeof buildApp>,
  method: Method,
  url: string,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${app.jwt.sign({ sub: "account-1" })}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe("the global tool catalogue boundary", () => {
  it("lets TEAM_ADMIN read tools and configure its group, but blocks catalogue mutations", async () => {
    const state = statefulApp({ grants: ["GROUPS", "TOOLS"] });
    await state.app.ready();

    expect((await inject(state.app, "GET", "/tools")).statusCode).toBe(200);
    expect((await inject(state.app, "GET", "/tools/tool-tasks")).statusCode).toBe(200);

    expect(
      (await inject(state.app, "POST", "/tools", { key: "TODO", name: "Yapilacaklar" }))
        .statusCode
    ).toBe(403);
    expect(
      (await inject(state.app, "PATCH", "/tools/tool-tasks", { name: "Isler" })).statusCode
    ).toBe(403);
    expect((await inject(state.app, "DELETE", "/tools/tool-tasks")).statusCode).toBe(403);
    expect(state.createTool).not.toHaveBeenCalled();
    expect(state.updateTool).not.toHaveBeenCalled();

    const groupResponse = await inject(state.app, "PUT", `/groups/${GROUP.id}/tools`, {
      tools: [{ tool: "TASKS", isEnabled: true }],
    });
    expect(groupResponse.statusCode).toBe(204);
    expect(state.groupTools).toEqual([
      { groupId: GROUP.id, toolId: "tool-tasks", isEnabled: true },
    ]);

    await state.app.close();
  });

  it("completes the TOOLS wizard step through the public API", async () => {
    const state = statefulApp({ grants: ["GROUPS", "TOOLS"], setupStage: "TOOLS" });
    await state.app.ready();

    const groupsResponse = await inject(
      state.app,
      "GET",
      "/groups?pageSize=100&includeInactive=true"
    );
    expect(groupsResponse.statusCode).toBe(200);
    expect(groupsResponse.json().items).toEqual([
      expect.objectContaining({ id: GROUP.id, name: GROUP.name }),
    ]);

    const saveResponse = await inject(state.app, "PUT", `/groups/${GROUP.id}/tools`, {
      tools: [
        { tool: "TASKS", isEnabled: true },
        { tool: "GROUPS", isEnabled: false },
      ],
    });
    expect(saveResponse.statusCode).toBe(204);
    expect(state.groupTools).toHaveLength(2);

    const advanceResponse = await inject(state.app, "POST", "/setup/advance");
    expect(advanceResponse.statusCode).toBe(200);
    expect(advanceResponse.json()).toMatchObject({ setupStage: "PERMISSIONS" });
    expect(state.stage()).toBe("PERMISSIONS");

    await state.app.close();
  });

  it("allows the fixed platform SYSTEM_ADMIN with the migrated TOOLS grant to mutate", async () => {
    const state = statefulApp({ platform: true, grants: ["TEAMS", "TOOLS"] });
    await state.app.ready();

    const createResponse = await inject(state.app, "POST", "/tools", {
      key: "TODO",
      name: "Yapilacaklar",
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as { id: string };

    const updateResponse = await inject(state.app, "PATCH", `/tools/${created.id}`, {
      name: "Kontrol Listesi",
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({ id: created.id, name: "Kontrol Listesi" });

    const deleteResponse = await inject(state.app, "DELETE", `/tools/${created.id}`);
    expect(deleteResponse.statusCode).toBe(204);
    expect(state.tools.find((tool) => tool.id === created.id)?.isActive).toBe(false);
    expect(state.createTool).toHaveBeenCalledTimes(1);
    expect(state.updateTool).toHaveBeenCalledTimes(2);

    await state.app.close();
  });

  it("does not let platform identity replace the missing TOOLS permission", async () => {
    const state = statefulApp({ platform: true, grants: ["TEAMS"] });
    await state.app.ready();

    expect(
      (await inject(state.app, "POST", "/tools", { key: "TODO", name: "Yapilacaklar" }))
        .statusCode
    ).toBe(403);
    expect(
      (await inject(state.app, "PATCH", "/tools/tool-tasks", { name: "Isler" })).statusCode
    ).toBe(403);
    expect((await inject(state.app, "DELETE", "/tools/tool-tasks")).statusCode).toBe(403);
    expect(state.createTool).not.toHaveBeenCalled();
    expect(state.updateTool).not.toHaveBeenCalled();

    await state.app.close();
  });
});
