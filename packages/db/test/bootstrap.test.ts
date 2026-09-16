import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/client";

import { PLATFORM_SYSTEM_ADMIN_ROLE_ID, bootstrapSystemAdmin } from "../src/bootstrap";

/**
 * A minimal in-memory stand-in for the rows bootstrapSystemAdmin touches,
 * shared across calls within one test the same way a real database would be.
 * The earlier version of this test hand-stubbed each call independently,
 * which was enough while the function only ever wrote the one account it was
 * given -- it stopped being enough once bootstrap also has to read "does an
 * account already exist here, and is it already the platform admin" and
 * "who else currently holds this role" before deciding what to write.
 */
function createFakeTx() {
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${++nextId}`;

  const accounts = new Map<
    string,
    { id: string; email: string; teamId: string | null; mustChangePassword: boolean }
  >();
  const accountRoles: { id: string; accountId: string; roleId: string; groupId: string | null; isActive: boolean }[] =
    [];
  const refreshTokens: { id: string; accountId: string; revokedAt: Date | null }[] = [];

  function accountByEmail(email: string) {
    return [...accounts.values()].find((a) => a.email === email) ?? null;
  }

  const tx = {
    $executeRaw: async () => 1,
    role: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === PLATFORM_SYSTEM_ADMIN_ROLE_ID ? { id: PLATFORM_SYSTEM_ADMIN_ROLE_ID } : null,
    },
    account: {
      findUnique: async ({ where }: { where: { email: string } }) => {
        const account = accountByEmail(where.email);
        if (!account) return null;
        return {
          id: account.id,
          teamId: account.teamId,
          roles: accountRoles
            .filter(
              (r) =>
                r.accountId === account.id &&
                r.roleId === PLATFORM_SYSTEM_ADMIN_ROLE_ID &&
                r.groupId === null
            )
            .map((r) => ({ id: r.id })),
        };
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { email: string };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        const existing = accountByEmail(where.email);
        if (existing) {
          Object.assign(existing, update);
          return { id: existing.id, email: existing.email };
        }
        const account = {
          id: id("account"),
          email: where.email,
          teamId: (create.teamId as string | null) ?? null,
          mustChangePassword: Boolean(create.mustChangePassword),
        };
        accounts.set(account.id, account);
        return { id: account.id, email: account.email };
      },
    },
    refreshToken: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { accountId: string | { in: string[] }; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        const ids = typeof where.accountId === "string" ? [where.accountId] : where.accountId.in;
        let count = 0;
        for (const token of refreshTokens) {
          if (ids.includes(token.accountId) && token.revokedAt === null) {
            token.revokedAt = data.revokedAt;
            count++;
          }
        }
        return { count };
      },
    },
    accountRole: {
      findFirst: async ({
        where,
      }: {
        where: { accountId: string; roleId: string; groupId: null };
      }) => {
        const row = accountRoles.find(
          (r) => r.accountId === where.accountId && r.roleId === where.roleId && r.groupId === where.groupId
        );
        return row ? { id: row.id } : null;
      },
      create: async ({
        data,
      }: {
        data: { accountId: string; roleId: string };
      }) => {
        const row = { id: id("assignment"), accountId: data.accountId, roleId: data.roleId, groupId: null, isActive: true };
        accountRoles.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: { isActive: boolean } }) => {
        const row = accountRoles.find((r) => r.id === where.id);
        if (row) row.isActive = data.isActive;
        return { id: where.id };
      },
      findMany: async ({
        where,
      }: {
        where: { roleId: string; groupId: null; isActive: true; accountId: { not: string } };
      }) =>
        accountRoles
          .filter(
            (r) =>
              r.roleId === where.roleId &&
              r.groupId === where.groupId &&
              r.isActive === where.isActive &&
              r.accountId !== where.accountId.not
          )
          .map((r) => ({ id: r.id, accountId: r.accountId })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: { in: string[] } };
        data: { isActive: boolean };
      }) => {
        let count = 0;
        for (const row of accountRoles) {
          if (where.id.in.includes(row.id)) {
            row.isActive = data.isActive;
            count++;
          }
        }
        return { count };
      },
    },
  };

  return {
    tx,
    seedAccount(input: { email: string; teamId?: string | null }) {
      const account = { id: id("account"), email: input.email, teamId: input.teamId ?? null, mustChangePassword: false };
      accounts.set(account.id, account);
      return account;
    },
    seedRefreshToken(accountId: string) {
      const token = { id: id("token"), accountId, revokedAt: null };
      refreshTokens.push(token);
      return token;
    },
    grantPlatformAdmin(accountId: string) {
      const row = { id: id("assignment"), accountId, roleId: PLATFORM_SYSTEM_ADMIN_ROLE_ID, groupId: null, isActive: true };
      accountRoles.push(row);
      return row;
    },
    isActiveAdmin(accountId: string) {
      return accountRoles.some(
        (r) => r.accountId === accountId && r.roleId === PLATFORM_SYSTEM_ADMIN_ROLE_ID && r.groupId === null && r.isActive
      );
    },
    activeAdminCount() {
      return accountRoles.filter(
        (r) => r.roleId === PLATFORM_SYSTEM_ADMIN_ROLE_ID && r.groupId === null && r.isActive
      ).length;
    },
    isTokenRevoked(tokenId: string) {
      return refreshTokens.find((t) => t.id === tokenId)?.revokedAt !== null;
    },
  };
}

function fakePrisma(tx: ReturnType<typeof createFakeTx>["tx"]) {
  return { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } as unknown as PrismaClient;
}

const hashPassword = { hashPassword: vi.fn(async () => "new-password-hash") };

describe("system administrator bootstrap", () => {
  it("creates the admin on first run and resets credentials + sessions on a rerun with the same email", async () => {
    const fake = createFakeTx();
    const prisma = fakePrisma(fake.tx);
    const input = { email: "admin@example.test", password: "replacement-password" };

    const first = await bootstrapSystemAdmin(prisma, input, hashPassword);
    expect(fake.isActiveAdmin(first.id)).toBe(true);

    const token = fake.seedRefreshToken(first.id);
    const second = await bootstrapSystemAdmin(prisma, input, hashPassword);

    expect(second.id).toBe(first.id);
    expect(fake.isTokenRevoked(token.id)).toBe(true);
    expect(fake.isActiveAdmin(second.id)).toBe(true);
  });

  it("refuses to convert an existing team member's account into the platform admin", async () => {
    const fake = createFakeTx();
    const member = fake.seedAccount({ email: "lead@example.test", teamId: "team-1" });
    const prisma = fakePrisma(fake.tx);

    await expect(
      bootstrapSystemAdmin(prisma, { email: "lead@example.test", password: "replacement-password" }, hashPassword)
    ).rejects.toThrow(/already exists.*lead@example\.test/is);

    // Untouched: still on its team, still holding no platform role.
    expect(fake.isActiveAdmin(member.id)).toBe(false);
  });

  it("moves A to B and back to inactive A while keeping one admin and revoking refresh tokens", async () => {
    const fake = createFakeTx();
    const prisma = fakePrisma(fake.tx);

    const original = await bootstrapSystemAdmin(
      prisma,
      { email: "old-admin@example.test", password: "original-password" },
      hashPassword
    );
    const originalToken = fake.seedRefreshToken(original.id);

    const replacement = await bootstrapSystemAdmin(
      prisma,
      { email: "new-admin@example.test", password: "replacement-password" },
      hashPassword
    );

    expect(replacement.id).not.toBe(original.id);
    expect(fake.isActiveAdmin(replacement.id)).toBe(true);
    // Exactly one platform admin survives this -- the old identity is not
    // left holding the role (and its old sessions) alongside the new one.
    expect(fake.isActiveAdmin(original.id)).toBe(false);
    expect(fake.isTokenRevoked(originalToken.id)).toBe(true);

    const replacementToken = fake.seedRefreshToken(replacement.id);
    const recoveredOriginal = await bootstrapSystemAdmin(
      prisma,
      { email: "old-admin@example.test", password: "recovered-password" },
      hashPassword
    );

    expect(recoveredOriginal.id).toBe(original.id);
    expect(fake.isActiveAdmin(original.id)).toBe(true);
    expect(fake.isActiveAdmin(replacement.id)).toBe(false);
    expect(fake.isTokenRevoked(replacementToken.id)).toBe(true);
    expect(fake.activeAdminCount()).toBe(1);
  });

  it("refuses the literal .env.example placeholder credentials", async () => {
    const fake = createFakeTx();
    const prisma = fakePrisma(fake.tx);

    await expect(
      bootstrapSystemAdmin(prisma, { email: "admin@breakpoint.test", password: "a-real-password-here" }, hashPassword)
    ).rejects.toThrow(/placeholder/i);

    await expect(
      bootstrapSystemAdmin(prisma, { email: "real-admin@example.test", password: "change-me-at-least-ten-chars" }, hashPassword)
    ).rejects.toThrow(/placeholder/i);
  });
});
