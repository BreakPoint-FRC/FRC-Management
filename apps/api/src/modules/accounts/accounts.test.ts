import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { ConflictError } from "../../lib/http-errors";
import { createAccountSchema, replaceRolesSchema } from "./accounts.schema";
import { createAccountsService } from "./accounts.service";

// Every service call is scoped to a team now. The id itself is arbitrary; what
// the tests pin is that it reaches the query.
const TEAM = "team-1";

describe("account payload validation", () => {
  it("rejects a password short enough to guess", async () => {
    const result = createAccountSchema.safeParse({
      email: "yeni@breakpoint.test",
      fullName: "Yeni Uye",
      password: "kisa",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["password"]);
  });

  it("rejects the same role twice in one list, pointing at the entry", async () => {
    const result = replaceRolesSchema.safeParse({
      roles: [
        { roleId: "role-lead", groupId: "group-programming" },
        { roleId: "role-lead", groupId: "group-programming" },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["roles", 1]);
  });

  it("accepts the same role in two different groups", async () => {
    // Two subteam leads is the case the whole list model exists for.
    const result = replaceRolesSchema.safeParse({
      roles: [
        { roleId: "role-lead", groupId: "group-programming" },
        { roleId: "role-lead", groupId: "group-electrical" },
      ],
    });

    expect(result.success).toBe(true);
  });
});

// groupId is required for an IN_GROUP role and forbidden for every other
// placement -- the others carry their coverage on the role itself. That is a
// conditional CHECK constraint the database cannot hold, so this is the only
// thing standing between the model and rows it cannot describe.
describe("role placement enforcement", () => {
  const ROLES = [
    { id: "role-lead", name: "Lead", placement: "IN_GROUP" },
    { id: "role-president", name: "Baskan", placement: "TEAM_WIDE" },
    { id: "role-director", name: "Teknik Direktor", placement: "ABOVE_GROUPS" },
  ];

  function stubPrisma() {
    return {
      role: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          ROLES.filter((role) => where.id.in.includes(role.id)),
        // The lockout guard asks whether the target still holds TEAM_ADMIN.
        count: async () => 0,
      },
      group: { count: async () => 1 },
      account: {
        findFirst: async () => ({ id: "account-1" }),
        findUniqueOrThrow: async () => ({
          id: "account-1",
          teamId: TEAM,
          email: "deniz@breakpoint.test",
          fullName: "Deniz Kaya",
          isActive: true,
          mustChangePassword: false,
          createdAt: new Date("2026-01-01"),
          archivedAt: null,
          roles: [],
          memberships: [],
        }),
      },
      accountRole: { deleteMany: vi.fn(), createMany: vi.fn(), count: async () => 0 },
      groupMembership: { upsert: vi.fn() },
      roleHierarchy: { findMany: async () => [] },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;
  }

  it("refuses a group role with no group", async () => {
    const service = createAccountsService(stubPrisma());

    await expect(
      service.replaceRoles(TEAM, "account-1", { roles: [{ roleId: "role-lead" }] }, "admin-1")
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a global role pinned to a group", async () => {
    const service = createAccountsService(stubPrisma());

    await expect(
      service.replaceRoles(
        TEAM,
        "account-1",
        { roles: [{ roleId: "role-president", groupId: "group-business" }] },
        "admin-1"
      )
    ).rejects.toThrow(/kapsamini kendisi tasir/);
  });

  it("refuses a role id that does not exist", async () => {
    const service = createAccountsService(stubPrisma());

    await expect(
      service.replaceRoles(TEAM, "account-1", { roles: [{ roleId: "role-ghost" }] }, "admin-1")
    ).rejects.toThrow(/Rol bulunamadi/);
  });

  it("creates the matching group membership alongside a group role", async () => {
    // Without this, authorize() would turn a freshly appointed member away from
    // their own department -- a bug that looks like a permissions problem and is
    // not. Only IN_GROUP does this: a director scoped from above never joins.
    const prisma = stubPrisma();
    const service = createAccountsService(prisma);

    await service.replaceRoles(
      TEAM,
      "account-1",
      { roles: [{ roleId: "role-lead", groupId: "group-programming" }] },
      "admin-1"
    );

    expect(prisma.groupMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId_groupId: { accountId: "account-1", groupId: "group-programming" } },
      })
    );
  });

  it("records who granted the roles", async () => {
    const prisma = stubPrisma();
    await createAccountsService(prisma).replaceRoles(
      TEAM,
      "account-1",
      { roles: [{ roleId: "role-president" }] },
      "admin-1"
    );

    expect(prisma.accountRole.createMany).toHaveBeenCalledWith({
      data: [
        { accountId: "account-1", roleId: "role-president", groupId: null, assignedById: "admin-1" },
      ],
    });
  });
});

describe("archiving", () => {
  it("clears isActive and revokes sessions in the same write", async () => {
    // Someone who has left should not still be able to sign in, and their
    // refresh token would otherwise stay valid for thirty days.
    const update = vi.fn();
    const revoke = vi.fn();
    const prisma = {
      account: { update, findFirst: async () => ({ id: "account-2" }) },
      // Not a team admin, so the last-admin guard has nothing to refuse.
      accountRole: { count: async () => 0 },
      refreshToken: { updateMany: revoke },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    await createAccountsService(prisma).archive(TEAM, "account-2");

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-2" },
        data: expect.objectContaining({ isActive: false }),
      })
    );
    expect(revoke).toHaveBeenCalled();
  });
});

// A team whose last TEAM_ADMIN is archived or demoted cannot create accounts,
// edit roles or reach its own settings, and there is no second way in. Fixing
// it means a platform admin and a database, so it is refused instead.
describe("the last team admin", () => {
  function stubPrisma(otherAdmins: number, targetIsAdmin: boolean) {
    return {
      account: { findFirst: async () => ({ id: "account-1" }), update: vi.fn() },
      accountRole: {
        // Called twice with different filters: "is this one an admin" and
        // "is there another one left". The stub answers by argument shape.
        count: async ({ where }: { where: { accountId?: unknown } }) =>
          typeof where.accountId === "string" ? (targetIsAdmin ? 1 : 0) : otherAdmins,
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      role: { count: async () => 0, findMany: async () => [] },
      refreshToken: { updateMany: vi.fn() },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;
  }

  it("refuses to archive the only one", async () => {
    const service = createAccountsService(stubPrisma(0, true));

    await expect(service.archive(TEAM, "account-1")).rejects.toThrow(/son yoneticisi/);
  });

  it("allows archiving one of two", async () => {
    const service = createAccountsService(stubPrisma(1, true));

    await expect(service.archive(TEAM, "account-1")).resolves.toBeUndefined();
  });

  it("allows archiving someone who was never an admin", async () => {
    const service = createAccountsService(stubPrisma(0, false));

    await expect(service.archive(TEAM, "account-9")).resolves.toBeUndefined();
  });

  it("refuses to suspend the only one, which locks the team out just as well", async () => {
    const service = createAccountsService(stubPrisma(0, true));

    await expect(
      service.update(TEAM, "account-1", { isActive: false })
    ).rejects.toThrow(/son yoneticisi/);
  });
});
