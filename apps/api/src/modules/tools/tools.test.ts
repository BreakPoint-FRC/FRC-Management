import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";

/**
 * The module catalogue is one list for the whole platform -- Tool carries no
 * teamId -- so editing it is a platform act even though the TOOLS permission is
 * something a team admin legitimately holds (it is also the gate on switching
 * modules on and off per department).
 *
 * As in teams.test.ts, these stubs make authorize() say yes. Every 403 below
 * comes from requirePlatform reading the account, which is what makes it
 * unreachable by writing rows.
 */
describe("/tools belongs to the platform, not to a team", () => {
  const TOOL_ROW = {
    id: "tool-tasks",
    key: "TASKS",
    name: "Gorevler",
    description: null,
    isActive: true,
  };

  const CALLER = {
    id: "account-1",
    email: "ada@breakpoint.test",
    fullName: "Ada Yilmaz",
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    memberships: [],
    roles: [
      { groupId: null, role: { id: "role-admin", placement: "TEAM_WIDE", groupScopes: [] } },
    ],
  };

  const teamAdmin = { ...CALLER, teamId: "team-1", team: { isActive: true } };
  const platformAdmin = { ...CALLER, teamId: null, team: null };

  const FULL = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

  const ROUTES = [
    { method: "GET" as const, url: "/tools", allowed: 200 },
    { method: "GET" as const, url: "/tools/tool-tasks", allowed: 200 },
    {
      method: "POST" as const,
      url: "/tools",
      payload: { key: "TASKS", name: "Gorevler" },
      allowed: 201,
    },
    { method: "PATCH" as const, url: "/tools/tool-tasks", payload: { name: "Isler" }, allowed: 200 },
    { method: "DELETE" as const, url: "/tools/tool-tasks", allowed: 204 },
  ];

  function appFor(account: unknown) {
    const prisma = {
      $disconnect: vi.fn(),
      account: { findUnique: async () => account },
      tool: {
        // Serves authorize's lookup by key and the service's own reads.
        findUnique: async () => TOOL_ROW,
        findMany: async () => [TOOL_ROW],
        create: async () => TOOL_ROW,
        update: async () => TOOL_ROW,
      },
      group: { findMany: async () => [] },
      groupTool: { findMany: async () => [] },
      roleHierarchy: { findMany: async () => [] },
      rolePermission: { findMany: async () => [FULL] },
    } as unknown as PrismaClient;

    return buildApp({ prisma });
  }

  for (const route of ROUTES) {
    it(`refuses ${route.method} ${route.url} for an account inside a team`, async () => {
      const app = appFor(teamAdmin);
      await app.ready();

      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${app.jwt.sign({ sub: CALLER.id })}` },
        ...("payload" in route ? { payload: route.payload } : {}),
      });

      expect(response.statusCode).toBe(403);
      await app.close();
    });
  }

  for (const route of ROUTES) {
    it(`allows ${route.method} ${route.url} for a platform account`, async () => {
      const app = appFor(platformAdmin);
      await app.ready();

      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${app.jwt.sign({ sub: CALLER.id })}` },
        ...("payload" in route ? { payload: route.payload } : {}),
      });

      expect(response.statusCode).toBe(route.allowed);
      await app.close();
    });
  }
});
