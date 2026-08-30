import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { ConflictError } from "../../lib/http-errors";
import { createRolesService } from "./roles.service";

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
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id })),
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

    await expect(service.linkRoles("lead", "lead")).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses an edge that closes a cycle", async () => {
    // team-lead -> lead -> member already exists. Adding member -> team-lead
    // would close the loop, and permission resolution walks these edges on
    // every authorized request.
    const service = createRolesService(stubPrisma());

    await expect(service.linkRoles("member", "team-lead")).rejects.toThrow(/dongu/);
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

    await expect(service.linkRoles("d", "a")).rejects.toThrow(/dongu/);
  });

  it("allows an edge that only deepens the tree", async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = createRolesService(
      stubPrisma({ roleHierarchy: { findMany: async () => EDGES, create } })
    );

    await service.linkRoles("member", "intern");

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

    await service.linkRoles("president", "lead");

    expect(create).toHaveBeenCalled();
  });
});

describe("deleting a role", () => {
  const stubForDelete = (role: unknown) =>
    ({
      role: { findUnique: async () => role, delete: vi.fn() },
    }) as unknown as PrismaClient;

  it("refuses a system role", async () => {
    const service = createRolesService(
      stubForDelete({ isSystemRole: true, name: "Sistem Yoneticisi", _count: { accountRoles: 0 } })
    );

    await expect(service.remove("system-admin")).rejects.toThrow(/Sistem rolleri silinemez/);
  });

  it("refuses a role that is still assigned, naming the count", async () => {
    // The foreign key would stop this anyway, but as a P2003 that reads
    // "Referenced record does not exist" -- which describes the opposite of
    // what happened.
    const service = createRolesService(
      stubForDelete({ isSystemRole: false, name: "Arsiv Sorumlusu", _count: { accountRoles: 3 } })
    );

    await expect(service.remove("role-x")).rejects.toThrow(/3 hesaba atanmis/);
  });

  it("deletes a role nothing depends on", async () => {
    const remove = vi.fn().mockResolvedValue({});
    const prisma = {
      role: {
        findUnique: async () => ({
          isSystemRole: false,
          name: "Kullanilmayan",
          _count: { accountRoles: 0 },
        }),
        delete: remove,
      },
    } as unknown as PrismaClient;

    await createRolesService(prisma).remove("role-unused");

    expect(remove).toHaveBeenCalledWith({ where: { id: "role-unused" } });
  });
});
