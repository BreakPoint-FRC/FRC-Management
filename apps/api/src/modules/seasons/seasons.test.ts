import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";

const FULL_PERMISSION = { canRead: true, canCreate: true, canUpdate: true, canDelete: true };

interface SeasonRow {
  id: string;
  teamId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  counts?: {
    tasks?: number;
    meetings?: number;
    transactions?: number;
    sponsorships?: number;
    ganttBoards?: number;
  };
}

type WhereClause = {
  id?: string | { not: string };
  teamId?: string;
  isActive?: boolean;
};

function accountRow(id: string, teamId: string) {
  return {
    id,
    email: `${id}@breakpoint.test`,
    fullName: "Sezon Yoneticisi",
    teamId,
    isActive: true,
    mustChangePassword: false,
    archivedAt: null,
    team: { isActive: true },
    memberships: [],
    roles: [
      {
        groupId: null,
        isActive: true,
        role: { id: `role-${teamId}`, placement: "TEAM_WIDE", groupScopes: [] },
      },
    ],
  };
}

function matches(row: SeasonRow, where: WhereClause = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === "object" && "not" in value) {
      return row[key as keyof SeasonRow] !== value.not;
    }
    return row[key as keyof SeasonRow] === value;
  });
}

function toDto(row: SeasonRow) {
  return {
    id: row.id,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    isActive: row.isActive,
    _count: {
      tasks: row.counts?.tasks ?? 0,
      meetings: row.counts?.meetings ?? 0,
      transactions: row.counts?.transactions ?? 0,
      sponsorships: row.counts?.sponsorships ?? 0,
      ganttBoards: row.counts?.ganttBoards ?? 0,
    },
  };
}

/**
 * One in-memory `season` table plus the account rows authorize() needs to
 * grant a TEAM_WIDE bypass. Mirrors the stubPrisma pattern in
 * groups.test.ts -- state lives in a plain array, and each Prisma method is a
 * thin, honest read/write over it rather than a mock returning canned values.
 */
function stubPrisma(seasons: SeasonRow[], accounts: Record<string, ReturnType<typeof accountRow>>) {
  const rows = seasons.map((row) => ({ ...row }));
  let nextId = rows.length + 1;

  const season = {
    findMany: async ({
      where,
      skip = 0,
      take,
    }: {
      where?: WhereClause;
      orderBy?: { startDate: "desc" };
      skip?: number;
      take?: number;
    }) => {
      const filtered = rows
        .filter((row) => matches(row, where))
        .sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
      return filtered.slice(skip, take === undefined ? undefined : skip + take).map(toDto);
    },
    count: async ({ where }: { where?: WhereClause } = {}) =>
      rows.filter((row) => matches(row, where)).length,
    findFirst: async ({ where }: { where: WhereClause }) => {
      const found = rows.find((row) => matches(row, where));
      return found ? toDto(found) : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const found = rows.find((row) => row.id === where.id);
      if (!found) {
        throw new Prisma.PrismaClientKnownRequestError("An operation failed", {
          code: "P2025",
          clientVersion: "7.9.1",
        });
      }
      return toDto(found);
    },
    create: async ({
      data,
    }: {
      data: { teamId: string; name: string; startDate: Date; endDate: Date; isActive?: boolean };
    }) => {
      if (rows.some((row) => row.teamId === data.teamId && row.name === data.name)) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`teamId`,`name`)",
          { code: "P2002", clientVersion: "7.9.1" }
        );
      }
      const row: SeasonRow = {
        id: `season-${nextId++}`,
        teamId: data.teamId,
        name: data.name,
        startDate: data.startDate,
        endDate: data.endDate,
        isActive: data.isActive ?? false,
      };
      rows.push(row);
      return { id: row.id };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<Pick<SeasonRow, "name" | "startDate" | "endDate" | "isActive">>;
    }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError("An operation failed", {
          code: "P2025",
          clientVersion: "7.9.1",
        });
      }
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: WhereClause; data: { isActive: boolean } }) => {
      const targets = rows.filter((row) => matches(row, where));
      for (const row of targets) row.isActive = data.isActive;
      return { count: targets.length };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = rows.findIndex((row) => row.id === where.id);
      if (index === -1) {
        throw new Prisma.PrismaClientKnownRequestError("An operation failed", {
          code: "P2025",
          clientVersion: "7.9.1",
        });
      }
      rows.splice(index, 1);
    },
  };

  const stub = {
    $disconnect: async () => {},
    $transaction: (operations: unknown) =>
      Array.isArray(operations) ? Promise.all(operations) : (operations as () => unknown)(),
    account: {
      findUnique: async ({ where }: { where: { id: string } }) => accounts[where.id] ?? null,
    },
    tool: { findUnique: async () => ({ id: "tool-seasons", isActive: true }) },
    group: { findMany: async () => [] },
    groupTool: { findMany: async () => [] },
    roleHierarchy: { findMany: async () => [] },
    rolePermission: { findMany: async () => [FULL_PERMISSION] },
    season,
  };

  return { prisma: stub as unknown as PrismaClient, rows };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function inject(
  app: ReturnType<typeof buildApp>,
  accountId: string,
  method: Method,
  url: string,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${app.jwt.sign({ sub: accountId })}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

const TEAM_1 = "team-1";
const TEAM_2 = "team-2";
const ADMIN_1 = "admin-team-1";
const ADMIN_2 = "admin-team-2";

function seasonRow(overrides: Partial<SeasonRow> & Pick<SeasonRow, "id" | "teamId" | "name">): SeasonRow {
  return {
    startDate: new Date("2025-01-01"),
    endDate: new Date("2025-06-01"),
    isActive: false,
    ...overrides,
  };
}

describe("seasons list and pagination", () => {
  it("returns only the caller's team, newest first", async () => {
    const { prisma } = stubPrisma(
      [
        seasonRow({ id: "s-2023", teamId: TEAM_1, name: "2023", startDate: new Date("2023-01-01") }),
        seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", startDate: new Date("2024-01-01") }),
        seasonRow({ id: "s-other-team", teamId: TEAM_2, name: "2024" }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "GET", "/seasons");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(2);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["s-2024", "s-2023"]);

    await app.close();
  });

  it("paginates with page and pageSize", async () => {
    const { prisma } = stubPrisma(
      [
        seasonRow({ id: "s-2022", teamId: TEAM_1, name: "2022", startDate: new Date("2022-01-01") }),
        seasonRow({ id: "s-2023", teamId: TEAM_1, name: "2023", startDate: new Date("2023-01-01") }),
        seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", startDate: new Date("2024-01-01") }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "GET", "/seasons?page=2&pageSize=1");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ page: 2, pageSize: 1, total: 3, totalPages: 3 });
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["s-2023"]);

    await app.close();
  });
});

describe("GET /seasons/current", () => {
  it("404s when the team has no active season", async () => {
    const { prisma } = stubPrisma(
      [seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: false })],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "GET", "/seasons/current");
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("returns the team's active season", async () => {
    const { prisma } = stubPrisma(
      [
        seasonRow({ id: "s-2023", teamId: TEAM_1, name: "2023", isActive: false }),
        seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: true }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "GET", "/seasons/current");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "s-2024" });

    await app.close();
  });
});

describe("POST /seasons", () => {
  it("refuses a name already used by the team, 409", async () => {
    const { prisma } = stubPrisma(
      [seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024" })],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "POST", "/seasons", {
      name: "2024",
      startDate: "2024-01-01",
      endDate: "2024-06-01",
    });
    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it("creating a season as isActive deactivates the previously active one", async () => {
    const { prisma, rows } = stubPrisma(
      [seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: true })],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "POST", "/seasons", {
      name: "2025",
      startDate: "2025-01-01",
      endDate: "2025-06-01",
      isActive: true,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "2025", isActive: true });
    expect(rows.find((row) => row.id === "s-2024")?.isActive).toBe(false);

    await app.close();
  });
});

describe("PATCH /seasons/:id", () => {
  it("updates a season's fields", async () => {
    const { prisma } = stubPrisma(
      [seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024" })],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "PATCH", "/seasons/s-2024", { name: "2024 Sezonu" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "s-2024", name: "2024 Sezonu" });

    await app.close();
  });

  it("activating through PATCH deactivates every other season for the team", async () => {
    const { prisma, rows } = stubPrisma(
      [
        seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: true }),
        seasonRow({ id: "s-2025", teamId: TEAM_1, name: "2025", isActive: false }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "PATCH", "/seasons/s-2025", { isActive: true });
    expect(response.statusCode).toBe(200);
    expect(rows.find((row) => row.id === "s-2025")?.isActive).toBe(true);
    expect(rows.find((row) => row.id === "s-2024")?.isActive).toBe(false);

    await app.close();
  });
});

describe("POST /seasons/:id/activate", () => {
  it("makes the target the only active season for the team", async () => {
    const { prisma, rows } = stubPrisma(
      [
        seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: true }),
        seasonRow({ id: "s-2025", teamId: TEAM_1, name: "2025", isActive: false }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "POST", "/seasons/s-2025/activate");
    expect(response.statusCode).toBe(200);
    expect(rows.find((row) => row.id === "s-2025")?.isActive).toBe(true);
    expect(rows.find((row) => row.id === "s-2024")?.isActive).toBe(false);

    await app.close();
  });
});

describe("cross-team isolation", () => {
  it("404s a read, update, activate or delete of another team's season", async () => {
    const { prisma } = stubPrisma(
      [seasonRow({ id: "s-other-team", teamId: TEAM_2, name: "2024" })],
      {
        [ADMIN_1]: accountRow(ADMIN_1, TEAM_1),
        [ADMIN_2]: accountRow(ADMIN_2, TEAM_2),
      }
    );
    const app = buildApp({ prisma });
    await app.ready();

    expect((await inject(app, ADMIN_1, "GET", "/seasons/s-other-team")).statusCode).toBe(404);
    expect(
      (await inject(app, ADMIN_1, "PATCH", "/seasons/s-other-team", { name: "x" })).statusCode
    ).toBe(404);
    expect(
      (await inject(app, ADMIN_1, "POST", "/seasons/s-other-team/activate")).statusCode
    ).toBe(404);
    expect((await inject(app, ADMIN_1, "DELETE", "/seasons/s-other-team")).statusCode).toBe(404);

    // Sanity check: the owning team can reach it fine.
    expect((await inject(app, ADMIN_2, "GET", "/seasons/s-other-team")).statusCode).toBe(200);

    await app.close();
  });
});

describe("DELETE /seasons/:id", () => {
  it("deletes an empty, inactive season", async () => {
    const { prisma, rows } = stubPrisma(
      [seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: false })],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "DELETE", "/seasons/s-2024");
    expect(response.statusCode).toBe(204);
    expect(rows.find((row) => row.id === "s-2024")).toBeUndefined();

    await app.close();
  });

  it("refuses to delete a season that still has operational records, 409", async () => {
    const { prisma, rows } = stubPrisma(
      [
        seasonRow({
          id: "s-2024",
          teamId: TEAM_1,
          name: "2024",
          isActive: false,
          counts: { tasks: 2 },
        }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "DELETE", "/seasons/s-2024");
    expect(response.statusCode).toBe(409);
    expect(rows.find((row) => row.id === "s-2024")).toBeDefined();

    await app.close();
  });

  it("refuses to delete the active season even with no records, 409", async () => {
    const { prisma, rows } = stubPrisma(
      [seasonRow({ id: "s-2024", teamId: TEAM_1, name: "2024", isActive: true })],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "DELETE", "/seasons/s-2024");
    expect(response.statusCode).toBe(409);
    expect(rows.find((row) => row.id === "s-2024")).toBeDefined();

    await app.close();
  });

  // Found in review, not in the original report: GanttBoard.season is
  // onDelete: Restrict (schema.prisma), but remove()'s emptiness check only
  // ever counted tasks/meetings/transactions/sponsorships. A season with
  // nothing but a lone Gantt board therefore read as "empty", fell through to
  // prisma.season.delete(), and hit the foreign key at the database instead
  // of getting the same clean ConflictError every other kind of record gets.
  it("refuses to delete a season that only has a Gantt board, 409", async () => {
    const { prisma, rows } = stubPrisma(
      [
        seasonRow({
          id: "s-2024",
          teamId: TEAM_1,
          name: "2024",
          isActive: false,
          counts: { ganttBoards: 1 },
        }),
      ],
      { [ADMIN_1]: accountRow(ADMIN_1, TEAM_1) }
    );
    const app = buildApp({ prisma });
    await app.ready();

    const response = await inject(app, ADMIN_1, "DELETE", "/seasons/s-2024");
    expect(response.statusCode).toBe(409);
    expect(rows.find((row) => row.id === "s-2024")).toBeDefined();

    await app.close();
  });
});
