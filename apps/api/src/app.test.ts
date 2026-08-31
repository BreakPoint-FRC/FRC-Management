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

/** An account that is signed in, active, and holds one all-powerful global role. */
const ADMIN = {
  id: "account-1",
  email: "ada@breakpoint.test",
  fullName: "Ada Yilmaz",
  isActive: true,
  archivedAt: null,
  roles: [{ groupId: null, role: { id: "role-admin", scope: "GLOBAL" } }],
};

const FULL_PERMISSION = {
  canRead: true,
  canCreate: true,
  canUpdate: true,
  canDelete: true,
};

/** The stub rows every authorized request walks through. */
function authorizedStubs(extra: Record<string, unknown> = {}) {
  return {
    tool: { findUnique: async () => ({ id: "tool-accounts", isActive: true }) },
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
});

describe("error handling", () => {
  it("maps a Prisma missing-record error to 404", async () => {
    const app = buildWithPrisma(
      stubClient({
        account: {
          findUnique: async () => ADMIN,
          update: async () => {
            throw new Prisma.PrismaClientKnownRequestError("not found", {
              code: "P2025",
              clientVersion: "7.9.1",
            });
          },
        },
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
          update: async () => {
            throw new Prisma.PrismaClientKnownRequestError("duplicate", {
              code: "P2002",
              clientVersion: "7.9.1",
            });
          },
        },
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
          update: async () => {
            throw new Error("connect ECONNREFUSED /var/run/postgres/.s.PGSQL.5432");
          },
        },
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
