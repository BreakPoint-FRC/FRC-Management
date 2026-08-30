import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { ConflictError } from "../../lib/http-errors";
import { createAccountSchema, replaceRolesSchema } from "./accounts.schema";
import { createAccountsService } from "./accounts.service";

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

// groupId is required for a GROUP-scoped role and forbidden for a GLOBAL one.
// That is a conditional CHECK constraint the database cannot hold, so this is
// the only thing standing between the model and rows it cannot describe.
describe("role scope enforcement", () => {
  const ROLES = [
    { id: "role-lead", name: "Lead", scope: "GROUP" },
    { id: "role-president", name: "Baskan", scope: "GLOBAL" },
  ];

  function stubPrisma() {
    return {
      role: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          ROLES.filter((role) => where.id.in.includes(role.id)),
      },
      account: {
        findUniqueOrThrow: async () => ({
          id: "account-1",
          email: "deniz@breakpoint.test",
          fullName: "Deniz Kaya",
          isActive: true,
          createdAt: new Date("2026-01-01"),
          archivedAt: null,
          roles: [],
          memberships: [],
        }),
      },
      accountRole: { deleteMany: vi.fn(), createMany: vi.fn() },
      groupMembership: { upsert: vi.fn() },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;
  }

  it("refuses a group role with no group", async () => {
    const service = createAccountsService(stubPrisma());

    await expect(
      service.replaceRoles("account-1", { roles: [{ roleId: "role-lead" }] }, "admin-1")
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a global role pinned to a group", async () => {
    const service = createAccountsService(stubPrisma());

    await expect(
      service.replaceRoles(
        "account-1",
        { roles: [{ roleId: "role-president", groupId: "group-business" }] },
        "admin-1"
      )
    ).rejects.toThrow(/takim geneli bir rol/);
  });

  it("refuses a role id that does not exist", async () => {
    const service = createAccountsService(stubPrisma());

    await expect(
      service.replaceRoles("account-1", { roles: [{ roleId: "role-ghost" }] }, "admin-1")
    ).rejects.toThrow(/Rol bulunamadi/);
  });

  it("creates the matching group membership alongside a group role", async () => {
    // Without this, step 4 of the authorization check would turn a freshly
    // appointed lead away from their own department -- a bug that looks like a
    // permissions problem and is not.
    const prisma = stubPrisma();
    const service = createAccountsService(prisma);

    await service.replaceRoles(
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
      account: { update },
      refreshToken: { updateMany: revoke },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    await createAccountsService(prisma).archive("account-2");

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-2" },
        data: expect.objectContaining({ isActive: false }),
      })
    );
    expect(revoke).toHaveBeenCalled();
  });
});
