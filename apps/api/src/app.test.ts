import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@breakpoint/db";

import { buildApp } from "./app";

// Everything here runs against a stub client and app.inject, so the suite needs
// neither a database nor a listening socket. The stub is the seam the prisma
// plugin exists for.

function stubClient(overrides: Record<string, unknown>) {
  return {
    $disconnect: vi.fn().mockResolvedValue(undefined),
    // Services use $transaction([...]) to pair a page with its count. The
    // elements are already promises from the stubs below.
    $transaction: (operations: unknown) =>
      Array.isArray(operations) ? Promise.all(operations) : (operations as () => unknown)(),
    ...overrides,
  };
}

function buildWithPrisma(stub: unknown) {
  return buildApp({ prisma: stub as PrismaClient });
}

const TEAM = "team-1";

/** An account that is signed in, active, and holds the team admin role. */
const ADMIN = {
  id: "account-1",
  teamId: TEAM,
  email: "ada@breakpoint.test",
  fullName: "Ada Yılmaz",
  isActive: true,
  mustChangePassword: false,
  archivedAt: null,
  team: { isActive: true },
  roles: [{ groupId: null, role: { id: "role-admin", placement: "TEAM_WIDE", groupScopes: [] } }],
  memberships: [],
};

const FULL_PERMISSION = {
  canRead: true,
  canCreate: true,
  canUpdate: true,
  canDelete: true,
};

/**
 * The stub rows every authorized request walks through.
 *
 * `group` and `groupTool` are here because authorize() loads the tree of the
 * team on every call: scoped placements expand down it and tool state is
 * inherited up it. A TEAM_WIDE role never consults either, but the load happens
 * before the placement is known.
 */
function authorizedStubs(extra: Record<string, unknown> = {}) {
  return {
    tool: { findUnique: async () => ({ id: "tool-accounts", isActive: true }) },
    group: { findMany: async () => [], count: async () => 0 },
    groupTool: { findMany: async () => [] },
    roleHierarchy: { findMany: async () => [] },
    rolePermission: { findMany: async () => [FULL_PERMISSION] },
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("health", () => {
  it("reports ok without a token", async () => {
    const app = buildWithPrisma(stubClient({}));
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("browser CORS preflights", () => {
  it.each(["PUT", "PATCH", "DELETE"])(
    "allows the %s mutations used by the cross-origin web app",
    async (method) => {
      const app = buildWithPrisma(stubClient({}));
      const response = await app.inject({
        method: "OPTIONS",
        url: "/gantt/board-1/tasks",
        headers: {
          origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(
        process.env.WEB_ORIGIN ?? "http://localhost:3000"
      );
      expect(
        response.headers["access-control-allow-methods"]
          ?.split(",")
          .map((allowedMethod) => allowedMethod.trim())
      ).toContain(method);
      expect(response.headers["access-control-allow-headers"]).toBe(
        "authorization,content-type"
      );
      await app.close();
    }
  );
});

describe("readiness", () => {
  it("uses and closes an isolated readiness probe when one is supplied", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({
      prisma: stubClient({}) as PrismaClient,
      readinessProbe: { check, close },
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(check).toHaveBeenCalledOnce();
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports ready when the database answers, without a token", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const app = buildWithPrisma(stubClient({ $queryRaw: queryRaw }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(queryRaw).toHaveBeenCalledOnce();
    await app.close();
  });

  // The one case /health cannot report: the process is up but the database it
  // depends on is not -- a container orchestrator should stop routing traffic
  // here without killing the process for it.
  it("reports 503 when the database is unreachable, and does not leak the driver error", async () => {
    const queryRaw = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const app = buildWithPrisma(stubClient({ $queryRaw: queryRaw }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not ready" });
    expect(response.body).not.toMatch(/ECONNREFUSED|5432/);
    await app.close();
  });

  // A hung query is not the same failure as a rejected one -- nothing throws,
  // so without its own bound this would hold the request (and a pool
  // connection) open forever instead of reporting not-ready.
  it("reports 503 if the database hangs instead of erroring, rather than waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const queryRaw = vi.fn().mockImplementation(() => new Promise(() => {}));
      const app = buildWithPrisma(stubClient({ $queryRaw: queryRaw }));

      const responsePromise = app.inject({ method: "GET", url: "/ready" });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await responsePromise;

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not ready" });
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rate limiting behind a trusted proxy", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY_HOPS;
  });

  function stubLoginPrisma() {
    return stubClient({ account: { findUnique: async () => null } });
  }

  function attempt(app: ReturnType<typeof buildWithPrisma>, forwardedFor: string) {
    return app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { email: "a@breakpoint.test", password: "wrong-password" },
    });
  }

  // The default (TRUST_PROXY_HOPS unset) has to stay safe on its own: every
  // request here shares light-my-request's default remote address, same as
  // every real caller would share Caddy's single socket peer address in
  // docker-compose.prod.yml. If an unset default trusted X-Forwarded-For
  // anyway, a caller could reset its own bucket just by sending a new one --
  // this proves it cannot.
  it("does not let a spoofed X-Forwarded-For bypass the limit when trust is not configured", async () => {
    delete process.env.TRUST_PROXY_HOPS;
    const app = buildWithPrisma(stubLoginPrisma());

    for (let i = 0; i < 10; i++) {
      await attempt(app, `10.0.0.${i}`);
    }
    const eleventh = await attempt(app, "10.0.0.99");

    expect(eleventh.statusCode).toBe(429);
    await app.close();
  });

  // The bug this exists to fix: behind Caddy, every real user's request has
  // the same socket peer address (Caddy's). Without reading TRUST_PROXY_HOPS,
  // the whole team shares one 10-per-minute bucket. With it set to 1, each
  // distinct X-Forwarded-For gets its own bucket again.
  it("keys the limit on X-Forwarded-For when TRUST_PROXY_HOPS=1, so distinct callers do not share one bucket", async () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const app = buildWithPrisma(stubLoginPrisma());

    for (let i = 0; i < 10; i++) {
      const response = await attempt(app, `10.0.0.${i}`);
      expect(response.statusCode).not.toBe(429);
    }
    const eleventh = await attempt(app, "10.0.0.99");

    expect(eleventh.statusCode).not.toBe(429);
    await app.close();
  });
});

describe("authentication", () => {
  it("refuses a protected route with no token", async () => {
    const app = buildWithPrisma(stubClient({}));
    const response = await app.inject({ method: "GET", url: "/accounts" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a token that is not signed by this server", async () => {
    const app = buildWithPrisma(stubClient({}));
    const response = await app.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: "Bearer not.a.real.token" },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a valid token whose account has since been deactivated", async () => {
    // The account is re-read on every request rather than trusted from the
    // token: suspending someone has to take effect now, not in fifteen minutes.
    const app = buildWithPrisma(
      stubClient({ account: { findUnique: async () => ({ ...ADMIN, isActive: false }) } })
    );
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lets an authorized account through", async () => {
    const app = buildWithPrisma(
      stubClient({
        account: {
          findUnique: async () => ADMIN,
          findFirst: async () => ADMIN,
          findMany: async () => [],
          count: async () => 0,
        },
        ...authorizedStubs(),
      })
    );
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ page: 1, pageSize: 25, total: 0, totalPages: 1 });
    await app.close();
  });

  it("returns 403, not 401, when the account is known but unauthorized", async () => {
    const app = buildWithPrisma(
      stubClient({
        account: { findUnique: async () => ({ ...ADMIN, roles: [] }) },
        ...authorizedStubs({ rolePermission: { findMany: async () => [] } }),
      })
    );
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});

// POST /accounts accepts a `roles` array in the same request. Found in review:
// the route only checked ACCOUNTS/create, so a role holding ACCOUNTS/create but
// not ROLES/update (PRESIDENT's default template, for one) could grant any role
// in the team -- TEAM_ADMIN included -- by routing through account creation
// instead of PUT /:id/roles, which does gate on ROLES/update. authorizedStubs()
// returns the same FULL_PERMISSION for every tool, which can't tell these two
// gates apart, hence the tool-scoped stub below.
describe("account creation cannot grant a role without ROLES/update", () => {
  const CREATOR = {
    id: "account-creator",
    teamId: TEAM,
    email: "baskan@breakpoint.test",
    fullName: "Baskan",
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    team: { isActive: true },
    roles: [
      { groupId: null, role: { id: "role-president", placement: "TEAM_WIDE", groupScopes: [] } },
    ],
    memberships: [],
  };

  /** Grants only the listed tool keys -- unlike authorizedStubs(), which grants everything. */
  function toolScopedStubs(grantedTools: Set<string>) {
    return {
      tool: {
        findUnique: async ({ where }: { where: { key: string } }) => ({
          id: `tool-${where.key}`,
          isActive: true,
        }),
      },
      group: { findMany: async () => [], count: async () => 0 },
      groupTool: { findMany: async () => [] },
      roleHierarchy: { findMany: async () => [] },
      rolePermission: {
        findMany: async ({ where }: { where: { toolId: string } }) =>
          grantedTools.has(where.toolId.replace("tool-", "")) ? [FULL_PERMISSION] : [],
      },
    };
  }

  /** Supports both service.create()'s top-level prisma.role.findMany call and its callback-style $transaction. */
  function transactionalStub() {
    const stub = {
      account: {
        findUnique: async () => CREATOR,
        create: async () => ({ id: "account-new" }),
        findUniqueOrThrow: async () => ({
          id: "account-new",
          teamId: TEAM,
          email: "yeni@breakpoint.test",
          fullName: "Yeni Üye",
          isActive: true,
          mustChangePassword: true,
          createdAt: new Date("2026-01-01"),
          archivedAt: null,
          roles: [],
          memberships: [],
        }),
      },
      role: {
        findMany: async () => [
          { id: "role-team-admin", name: "Takim Yoneticisi", placement: "TEAM_WIDE" },
        ],
      },
      accountRole: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: async () => [] },
      groupMembership: { upsert: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    return Object.assign(stub, {
      $transaction: async (work: unknown) =>
        Array.isArray(work) ? Promise.all(work) : (work as (tx: typeof stub) => unknown)(stub),
    });
  }

  function createRequest(app: ReturnType<typeof buildWithPrisma>, roles?: unknown[]) {
    return app.inject({
      method: "POST",
      url: "/accounts",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: CREATOR.id })}` },
      payload: {
        email: "yeni@breakpoint.test",
        fullName: "Yeni Üye",
        password: "cok-guclu-bir-sifre-123",
        ...(roles ? { roles } : {}),
      },
    });
  }

  function bulkRequest(app: ReturnType<typeof buildWithPrisma>, roles: unknown[]) {
    return app.inject({
      method: "POST",
      url: "/accounts/bulk-import/commit",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: CREATOR.id })}` },
      payload: {
        csv: "fullName,email\nYeni Üye,yeni@breakpoint.test\n",
        roles,
      },
    });
  }

  it("refuses to grant a role on creation without ROLES/update", async () => {
    const app = buildWithPrisma(
      stubClient({ ...transactionalStub(), ...toolScopedStubs(new Set(["ACCOUNTS"])) })
    );
    await app.ready();

    const response = await createRequest(app, [{ roleId: "role-team-admin" }]);

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("also refuses role grants through bulk import without ROLES/update", async () => {
    const app = buildWithPrisma(
      stubClient({ ...transactionalStub(), ...toolScopedStubs(new Set(["ACCOUNTS"])) })
    );
    await app.ready();

    const response = await bulkRequest(app, [{ roleId: "role-team-admin" }]);

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("still allows creating a roleless account with only ACCOUNTS/create", async () => {
    const app = buildWithPrisma(
      stubClient({ ...transactionalStub(), ...toolScopedStubs(new Set(["ACCOUNTS"])) })
    );
    await app.ready();

    const response = await createRequest(app);

    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("allows granting a role on creation when the caller also holds ROLES/update", async () => {
    const app = buildWithPrisma(
      stubClient({
        ...transactionalStub(),
        ...toolScopedStubs(new Set(["ACCOUNTS", "ROLES"])),
      })
    );
    await app.ready();

    const response = await createRequest(app, [{ roleId: "role-team-admin" }]);

    expect(response.statusCode).toBe(201);
    await app.close();
  });
});

describe("refresh tokens travel in the body", () => {
  // They used to be an httpOnly cookie. The web app now stores nothing on the
  // device at all, so the token is handed back in the response and held in
  // memory -- which means these routes must neither read nor set a cookie.

  /** A live, unexpired, unrevoked token row belonging to ADMIN. */
  function storedToken() {
    return {
      id: "rt-1",
      accountId: ADMIN.id,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    };
  }

  function refreshStubs(overrides: Record<string, unknown> = {}) {
    return stubClient({
      account: { findUnique: async () => ADMIN },
      refreshToken: {
        findUnique: async () => storedToken(),
        update: async () => storedToken(),
        create: async () => storedToken(),
        updateMany: async () => ({ count: 1 }),
        ...overrides,
      },
    });
  }

  it("rotates a token read from the body and answers with the new one", async () => {
    const app = buildWithPrisma(refreshStubs());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: "whatever-the-client-held" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.accessToken).toBe("string");
    // The rotated token has to come back in the body, or the client has no way
    // to reach it and the next refresh replays a token the server just revoked.
    expect(typeof body.refreshToken).toBe("string");
    expect(body.refreshToken).not.toBe("whatever-the-client-held");
    expect(response.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("refuses a refresh with nothing to spend", async () => {
    // The old route read a cookie the browser attached on its own, so a missing
    // one was invisible. Now an empty body is a request the client got wrong.
    const app = buildWithPrisma(refreshStubs());
    await app.ready();

    const response = await app.inject({ method: "POST", url: "/auth/refresh", payload: {} });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("revokes the token a logout carries", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const app = buildWithPrisma(refreshStubs({ updateMany }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: "the-one-in-memory" },
    });

    expect(response.statusCode).toBe(204);
    expect(updateMany).toHaveBeenCalledOnce();
    await app.close();
  });

  it("still returns 204 when a logout has no token to send", async () => {
    // A tab that was reloaded has already lost its token. It still wanted the
    // session gone, and reporting that as an error would be noise.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const app = buildWithPrisma(refreshStubs({ updateMany }));
    await app.ready();

    const response = await app.inject({ method: "POST", url: "/auth/logout", payload: {} });

    expect(response.statusCode).toBe(204);
    expect(updateMany).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("validation", () => {
  it("turns a Zod failure into a 400 carrying the issues", async () => {
    const app = buildWithPrisma(stubClient({}));
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "not-an-email", password: "" },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe("Invalid request");
    expect(body.issues.length).toBeGreaterThan(0);
    await app.close();
  });

  it("rejects a page size past the cap instead of returning the whole table", async () => {
    const app = buildWithPrisma(
      stubClient({ account: { findUnique: async () => ADMIN }, ...authorizedStubs() })
    );
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/accounts?pageSize=5000",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  // #44: three candidate-list pickers (task assignee, group member, Gantt task)
  // asked for pageSize=200 and got exactly the 400 above on every open, for
  // real -- unlike pageSize=5000 above, this is the literal value the web app
  // sent. A service-level unit test would miss it, since it calls the service
  // directly and never goes through this schema; the bug only shows up on the
  // real route, which is why it survived the existing test suite.
  it("rejects pageSize=200, the exact value the candidate-list pickers used to send", async () => {
    const app = buildWithPrisma(
      stubClient({ account: { findUnique: async () => ADMIN }, ...authorizedStubs() })
    );
    await app.ready();

    const auth = { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` };
    const accounts = await app.inject({ method: "GET", url: "/accounts?pageSize=200", headers: auth });
    const tasks = await app.inject({ method: "GET", url: "/tasks?pageSize=200", headers: auth });

    expect(accounts.statusCode).toBe(400);
    expect(tasks.statusCode).toBe(400);
    await app.close();
  });
});

describe("error handling", () => {
  it("maps a Prisma missing-record error to 404", async () => {
    const app = buildWithPrisma(
      stubClient({
        account: {
          findUnique: async () => ADMIN,
          // The service proves the target is this team's before it writes, so
          // the stub has to answer that lookup as well as the update.
          findFirst: async () => ({ id: "missing" }),
          findUniqueOrThrow: async () => ADMIN,
          update: async () => {
            throw new Prisma.PrismaClientKnownRequestError("not found", {
              code: "P2025",
              clientVersion: "7.9.1",
            });
          },
        },
        accountRole: { count: async () => 0 },
        ...authorizedStubs(),
      })
    );
    await app.ready();

    const response = await app.inject({
      method: "PATCH",
      url: "/accounts/missing",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
      payload: { fullName: "Yeni Ad" },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("maps a unique-constraint violation to 409", async () => {
    const app = buildWithPrisma(
      stubClient({
        account: {
          findUnique: async () => ADMIN,
          findFirst: async () => ({ id: "account-2" }),
          findUniqueOrThrow: async () => ADMIN,
          update: async () => {
            throw new Prisma.PrismaClientKnownRequestError("duplicate", {
              code: "P2002",
              clientVersion: "7.9.1",
            });
          },
        },
        accountRole: { count: async () => 0 },
        ...authorizedStubs(),
      })
    );
    await app.ready();

    const response = await app.inject({
      method: "PATCH",
      url: "/accounts/account-2",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
      payload: { email: "taken@breakpoint.test" },
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("tells the client nothing about an unexpected failure", async () => {
    const app = buildWithPrisma(
      stubClient({
        account: {
          findUnique: async () => ADMIN,
          findFirst: async () => ({ id: "account-2" }),
          findUniqueOrThrow: async () => ADMIN,
          update: async () => {
            throw new Error("connect ECONNREFUSED /var/run/postgres/.s.PGSQL.5432");
          },
        },
        accountRole: { count: async () => 0 },
        ...authorizedStubs(),
      })
    );
    await app.ready();
    vi.spyOn(app.log, "error").mockImplementation(() => app.log);

    const response = await app.inject({
      method: "PATCH",
      url: "/accounts/account-2",
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: ADMIN.id })}` },
      payload: { fullName: "Yeni Ad" },
    });

    expect(response.statusCode).toBe(500);
    // The body must not carry the path, the driver, or the original message.
    expect(response.body).not.toMatch(/PGSQL|ECONNREFUSED|var\/run/);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
    await app.close();
  });
});
