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

/**
 * The platform surface is decided by the tenancy of the account, not by a
 * permission row.
 *
 * These stubs deliberately make authorize() say *yes*: the caller holds a
 * TEAM_WIDE role granting full CRUD on TEAMS. That is exactly the state a team
 * admin could reach on their own -- roles are theirs to write, and the bypass
 * in authorize reads the placement of a role rather than whose role it is. So
 * every 403 below comes from requirePlatform, and would still be a 403 if the
 * grant had been written straight into the database.
 */
describe("/teams belongs to the platform, not to a team", () => {
  const TEAM_ROW = {
    id: "team-2",
    name: "Breakpoint",
    slug: "breakpoint",
    isActive: true,
    setupStage: "DONE",
    setupCompletedAt: null,
    createdAt: new Date("2026-01-01"),
    _count: { accounts: 3, groups: 2 },
  };

  const CALLER = {
    id: "account-1",
    email: "ada@breakpoint.test",
    fullName: "Ada Yilmaz",
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    memberships: [],
  };

  /** A team admin holding a role they wrote themselves, granting all of TEAMS. */
  const forged = (roleKey: string) => ({
    ...CALLER,
    teamId: "team-1",
    team: { isActive: true },
    roles: [
      { groupId: null, role: { id: "role-forged", key: roleKey, placement: "TEAM_WIDE", groupScopes: [] } },
    ],
  });

  /** The real thing: no team at all. */
  const platformAdmin = {
    ...CALLER,
    teamId: null,
    team: null,
    roles: [
      { groupId: null, role: { id: "role-system", key: "SYSTEM_ADMIN", placement: "TEAM_WIDE", groupScopes: [] } },
    ],
  };

  const FULL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

  const ROUTES = [
    { method: "GET" as const, url: "/teams", allowed: 200 },
    { method: "GET" as const, url: "/teams/team-2", allowed: 200 },
    {
      method: "POST" as const,
      url: "/teams",
      payload: { name: "Yeni Takim", adminFullName: "Yeni Yonetici", adminEmail: "new@breakpoint.test" },
      allowed: 201,
    },
    { method: "PATCH" as const, url: "/teams/team-2", payload: { name: "Yeni Ad" }, allowed: 200 },
    {
      method: "POST" as const,
      url: "/teams/team-2/admins",
      payload: { fullName: "Ikinci Yonetici", email: "second@breakpoint.test" },
      allowed: 201,
    },
    { method: "DELETE" as const, url: "/teams/team-2", allowed: 204 },
  ];

  function appFor(account: unknown, toolLookup = vi.fn(async () => ({ id: "tool-teams", isActive: true }))) {
    const prisma = asPrisma({
      $disconnect: vi.fn(),
      $transaction: (operations: unknown) =>
        Array.isArray(operations)
          ? Promise.all(operations)
          : (operations as (tx: unknown) => unknown)({
              team: { create: async () => ({ id: "team-new" }) },
              role: {
                create: async () => ({ id: "role-admin-new" }),
                findFirst: async () => ({ id: "role-admin" }),
              },
              tool: { findMany: async () => [{ id: "tool-tasks" }] },
              rolePermission: { createMany: async () => ({ count: 1 }) },
              account: {
                count: async () => 0,
                create: async () => ({
                  id: "account-new",
                  email: "new@breakpoint.test",
                  fullName: "Yeni Yonetici",
                }),
              },
              accountRole: { create: async () => ({}) },
            }),
      // Reached by both authenticate and authorize; the caller, never a target.
      account: { findUnique: async () => account, updateMany: async () => ({ count: 1 }) },
      team: {
        findUnique: async () => TEAM_ROW,
        findUniqueOrThrow: async () => TEAM_ROW,
        findMany: async () => [TEAM_ROW],
        count: async () => 0,
        update: async () => TEAM_ROW,
      },
      refreshToken: { updateMany: async () => ({ count: 0 }) },
      // authorize() loads these before it knows the placement.
      tool: { findUnique: toolLookup },
      group: { findMany: async () => [] },
      groupTool: { findMany: async () => [] },
      roleHierarchy: { findMany: async () => [] },
      rolePermission: { findMany: async () => [FULL] },
    });

    return buildApp({ prisma });
  }

  async function call(app: Awaited<ReturnType<typeof appFor>>, route: (typeof ROUTES)[number]) {
    return app.inject({
      method: route.method,
      url: route.url,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: CALLER.id })}` },
      ...("payload" in route ? { payload: route.payload } : {}),
    });
  }

  for (const route of ROUTES) {
    it(`refuses ${route.method} ${route.url} for an account inside a team`, async () => {
      const app = appFor(forged("KURUCU"));
      await app.ready();

      const response = await call(app, route);

      expect(response.statusCode).toBe(403);
      await app.close();
    });
  }

  it("refuses it even when the team called its own role SYSTEM_ADMIN", async () => {
    // Role.key is unique per team (@@unique([teamId, key])), so a team can
    // create its own SYSTEM_ADMIN and it is a different row from the platform
    // one. Nothing here reads the key -- which is the point.
    const app = appFor(forged("SYSTEM_ADMIN"));
    await app.ready();

    const response = await call(app, ROUTES[2]);

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("refuses before it asks the database anything about permissions", async () => {
    // requirePlatform is synchronous and runs first, so a request that cannot
    // succeed never pays for the authorization queries.
    const toolLookup = vi.fn(async () => ({ id: "tool-teams", isActive: true }));
    const app = appFor(forged("KURUCU"), toolLookup);
    await app.ready();

    await call(app, ROUTES[0]);

    expect(toolLookup).not.toHaveBeenCalled();
    await app.close();
  });

  for (const route of ROUTES) {
    it(`allows ${route.method} ${route.url} for a platform account`, async () => {
      const app = appFor(platformAdmin);
      await app.ready();

      const response = await call(app, route);

      expect(response.statusCode).toBe(route.allowed);
      await app.close();
    });
  }
});
