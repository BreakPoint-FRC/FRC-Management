import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@breakpoint/db";
import { buildApp } from "./app";

function buildWithPrisma(stub: unknown) {
  return buildApp({ prisma: stub as PrismaClient });
}

// A stub client whose $disconnect is a no-op, so app.close() stays offline.
function stubClient(overrides: Record<string, unknown>) {
  return { $disconnect: vi.fn().mockResolvedValue(undefined), ...overrides };
}

describe("app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a health check without touching the database", async () => {
    const app = buildWithPrisma(stubClient({}));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("disconnects prisma when the app closes", async () => {
    // The shutdown path SIGTERM relies on: app.close() must run the onClose hook.
    // (The signal wiring itself can't be exercised on win32, which has no POSIX signals.)
    const client = stubClient({});
    const app = buildWithPrisma(client);
    await app.ready();

    await app.close();

    expect(client.$disconnect).toHaveBeenCalledOnce();
  });

  it("returns 404 when a member does not exist", async () => {
    const app = buildWithPrisma(
      stubClient({ member: { findUnique: vi.fn().mockResolvedValue(null) } })
    );

    const response = await app.inject({ method: "GET", url: "/members/nope" });

    // Regression guard: this used to serialize `null` as a 200 response.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      statusCode: 404,
      error: "Not Found",
      message: "Member not found",
    });

    await app.close();
  });

  it("maps a Prisma P2025 on delete to 404", async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found.",
      { code: "P2025", clientVersion: "7.9.1" }
    );
    const app = buildWithPrisma(
      stubClient({ member: { delete: vi.fn().mockRejectedValue(notFound) } })
    );

    const response = await app.inject({ method: "DELETE", url: "/members/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404, error: "Not Found" });

    await app.close();
  });

  it("maps a Prisma P2002 unique violation to 409", async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`email`)",
      { code: "P2002", clientVersion: "7.9.1" }
    );
    const app = buildWithPrisma(
      stubClient({ member: { create: vi.fn().mockRejectedValue(duplicate) } })
    );

    const response = await app.inject({
      method: "POST",
      url: "/members",
      payload: { name: "Ada Lovelace", email: "ada@example.com" },
    });

    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it("does not leak internal error details in a 500 response", async () => {
    const leaky = new Error(
      "Invalid `prisma.member.findMany()` invocation in C:\\Users\\secret\\path\\app.js"
    );
    const app = buildWithPrisma(
      stubClient({ member: { findMany: vi.fn().mockRejectedValue(leaky) } })
    );
    // The handler logs the real error; keep it out of the test output.
    vi.spyOn(app.log, "error").mockImplementation(() => app.log);

    const response = await app.inject({ method: "GET", url: "/members" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
    // The actual regression guard for the disclosure bug.
    expect(response.body).not.toContain("prisma.member");
    expect(response.body).not.toContain("C:\\");

    await app.close();
  });
});
