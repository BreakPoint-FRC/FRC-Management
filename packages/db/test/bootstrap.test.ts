import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/client";

import {
  PLATFORM_SYSTEM_ADMIN_ROLE_ID,
  bootstrapSystemAdmin,
} from "../src/bootstrap";

describe("system administrator bootstrap", () => {
  it("resets credentials, revokes tokens, and restores one role assignment transactionally", async () => {
    let inTransaction = false;
    let assignmentId: string | null = null;

    const accountUpsert = vi.fn(async (args: { update: Record<string, unknown> }) => {
      expect(inTransaction).toBe(true);
      expect(args.update).toMatchObject({
        passwordHash: "new-password-hash",
        mustChangePassword: false,
        teamId: null,
        isActive: true,
        archivedAt: null,
      });
      return { id: "system-account", email: "admin@example.test" };
    });
    const revokeTokens = vi.fn(async () => {
      expect(inTransaction).toBe(true);
      return { count: 2 };
    });
    const createAssignment = vi.fn(async () => {
      expect(inTransaction).toBe(true);
      assignmentId = "assignment-1";
      return { id: assignmentId };
    });
    const restoreAssignment = vi.fn(async () => {
      expect(inTransaction).toBe(true);
      return { id: assignmentId };
    });

    const tx = {
      role: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          expect(inTransaction).toBe(true);
          expect(where.id).toBe(PLATFORM_SYSTEM_ADMIN_ROLE_ID);
          return { id: PLATFORM_SYSTEM_ADMIN_ROLE_ID };
        },
      },
      account: { upsert: accountUpsert },
      refreshToken: { updateMany: revokeTokens },
      accountRole: {
        findFirst: async () => (assignmentId ? { id: assignmentId } : null),
        create: createAssignment,
        update: restoreAssignment,
      },
    };
    const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => {
      inTransaction = true;
      try {
        return await fn(tx);
      } finally {
        inTransaction = false;
      }
    });
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    const input = { email: "admin@example.test", password: "replacement-password" };
    const dependencies = { hashPassword: vi.fn(async () => "new-password-hash") };

    await bootstrapSystemAdmin(prisma, input, dependencies);
    await bootstrapSystemAdmin(prisma, input, dependencies);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(accountUpsert).toHaveBeenCalledTimes(2);
    expect(revokeTokens).toHaveBeenCalledTimes(2);
    expect(revokeTokens).toHaveBeenLastCalledWith({
      where: { accountId: "system-account", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(createAssignment).toHaveBeenCalledOnce();
    expect(restoreAssignment).toHaveBeenCalledOnce();
    expect(restoreAssignment).toHaveBeenCalledWith({
      where: { id: "assignment-1" },
      data: { isActive: true },
    });
  });
});
