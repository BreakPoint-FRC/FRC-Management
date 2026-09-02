import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";
import { authorize } from "../../lib/authorize";
import { ConflictError, UnauthorizedError } from "../../lib/http-errors";
import { createAuthService } from "../auth/auth.service";
import { updateTeamSchema } from "./teams.schema";
import { createTeamsService } from "./teams.service";

vi.mock("../../lib/password", () => ({
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  verifyPassword: vi.fn(async () => true),
}));

const ACTIVE_ACCOUNT = {
  id: "account-1",
  email: "member@example.test",
  fullName: "Member",
  passwordHash: "stored-hash",
  teamId: "team-1",
  isActive: true,
  mustChangePassword: false,
  archivedAt: null,
  team: { isActive: true },
  roles: [],
  memberships: [],
};

function asPrisma(value: unknown): PrismaClient {
  return value as PrismaClient;
}

describe("team update validation", () => {
  it("accepts only a name", () => {
    expect(updateTeamSchema.safeParse({ name: "New name" }).success).toBe(true);
    expect(updateTeamSchema.safeParse({}).success).toBe(false);
    expect(updateTeamSchema.safeParse({ isActive: true }).success).toBe(false);
    expect(updateTeamSchema.safeParse({ name: "New name", unexpected: true }).success).toBe(false);
  });
});

describe("team archival", () => {
  it("deactivates the team and its accounts and revokes sessions together", async () => {
    const teamUpdate = vi.fn().mockResolvedValue({});
    const accountUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const tokenUpdateMany = vi.fn().mockResolvedValue({ count: 3 });
    const transaction = vi.fn(async (operations: unknown[]) => Promise.all(operations));
    const prisma = asPrisma({
      team: { findUnique: async () => ({ isActive: true }), update: teamUpdate },
      account: { updateMany: accountUpdateMany },
      refreshToken: { updateMany: tokenUpdateMany },
      $transaction: transaction,
    });

    await createTeamsService(prisma).archive("team-1");

    expect(transaction).toHaveBeenCalledOnce();
    expect(teamUpdate).toHaveBeenCalledWith({
      where: { id: "team-1" },
      data: { isActive: false },
    });
    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { teamId: "team-1" },
      data: { isActive: false },
    });
    expect(tokenUpdateMany).toHaveBeenCalledWith({
      where: { account: { teamId: "team-1" }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("refuses to add an administrator to an archived team before starting a transaction", async () => {
    const transaction = vi.fn();
    const prisma = asPrisma({
      team: { findUnique: async () => ({ isActive: false }) },
      $transaction: transaction,
    });

    await expect(
      createTeamsService(prisma).addAdmin(
        "team-1",
        { fullName: "New Admin", email: "admin@example.test" },
        "system-admin"
      )
    ).rejects.toBeInstanceOf(ConflictError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("archived teams are an authentication boundary", () => {
  const inactiveTeamAccount = { ...ACTIVE_ACCOUNT, team: { isActive: false } };

  it("rejects login even when the account and password are valid", async () => {
    const service = createAuthService(
      asPrisma({ account: { findUnique: async () => inactiveTeamAccount } })
    );

    await expect(service.login(ACTIVE_ACCOUNT.email, "correct-password")).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  it("still permits a platform administrator with no team", async () => {
    const service = createAuthService(
      asPrisma({ account: { findUnique: async () => ({ ...ACTIVE_ACCOUNT, teamId: null, team: null }) } })
    );

    await expect(service.login(ACTIVE_ACCOUNT.email, "correct-password")).resolves.toMatchObject({
      id: ACTIVE_ACCOUNT.id,
    });
  });

  it("rejects refresh-token rotation before issuing a replacement", async () => {
    const transaction = vi.fn();
    const service = createAuthService(
      asPrisma({
        refreshToken: {
          findUnique: async () => ({
            id: "token-1",
            accountId: ACTIVE_ACCOUNT.id,
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          }),
        },
        account: { findUnique: async () => inactiveTeamAccount },
        $transaction: transaction,
      })
    );

    await expect(service.rotateRefreshToken("live-token")).rejects.toBeInstanceOf(
      UnauthorizedError
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects profile loading before resolving permissions", async () => {
    const roleFindMany = vi.fn();
    const service = createAuthService(
      asPrisma({
        account: { findUnique: async () => inactiveTeamAccount },
        roleHierarchy: { findMany: roleFindMany },
      })
    );

    await expect(service.profile(ACTIVE_ACCOUNT.id)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(roleFindMany).not.toHaveBeenCalled();
  });

  it("rejects a signed access token on request authentication", async () => {
    const app = buildApp({
      prisma: asPrisma({
        account: { findUnique: async () => inactiveTeamAccount },
        $disconnect: vi.fn(),
      }),
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/teams",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ACTIVE_ACCOUNT.id })}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects direct authorization-context loading", async () => {
    const toolLookup = vi.fn();
    const prisma = asPrisma({
      account: { findUnique: async () => inactiveTeamAccount },
      tool: { findUnique: toolLookup },
    });

    await expect(
      authorize(prisma, { accountId: ACTIVE_ACCOUNT.id, tool: "TEAMS", action: "read" })
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(toolLookup).not.toHaveBeenCalled();
  });
});
