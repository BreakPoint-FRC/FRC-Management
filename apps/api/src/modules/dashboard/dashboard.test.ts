import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import { EMPTY_PERMISSIONS, type PermissionSet } from "@breakpoint/types";

// dashboard.service.ts calls resolvePermissionMatrix/canPerform directly
// (rather than authorize(), which throws) -- both are already covered by
// authorize.test.ts, so this file stubs their *output* and tests only what
// this service does with it: which tier a matrix produces, and which query
// each tier runs. A full Account/Role/GroupTool stub would only re-test
// resolvePermissionMatrix a second time under a different file name.
vi.mock("../../lib/authorize", () => ({
  resolvePermissionMatrix: vi.fn(),
  canPerform: vi.fn(),
}));

import { canPerform, resolvePermissionMatrix } from "../../lib/authorize";
import { createDashboardService } from "./dashboard.service";
import type { AuthenticatedAccount } from "../../plugins/auth";

const mockedResolve = vi.mocked(resolvePermissionMatrix);
const mockedCanPerform = vi.mocked(canPerform);

const TEAM = "team-1";
const ACCOUNT_ID = "acc-1";

function account(teamId: string | null = TEAM): AuthenticatedAccount {
  return { id: ACCOUNT_ID, email: "x@breakpoint.test", fullName: "X", teamId, mustChangePassword: false };
}

function permission(overrides: Partial<PermissionSet> = {}): PermissionSet {
  return { ...EMPTY_PERMISSIONS, ...overrides };
}

/** A resolved matrix with every tool absent (read as EMPTY_PERMISSIONS) except what is given. */
function matrix(options: {
  global?: Partial<Record<string, Partial<PermissionSet>>>;
  byGroup?: Record<string, Partial<Record<string, Partial<PermissionSet>>>>;
}) {
  const global: Record<string, PermissionSet> = {};
  for (const [tool, flags] of Object.entries(options.global ?? {})) global[tool] = permission(flags);

  const byGroup: Record<string, Record<string, PermissionSet>> = {};
  for (const [groupId, tools] of Object.entries(options.byGroup ?? {})) {
    byGroup[groupId] = {};
    for (const [tool, flags] of Object.entries(tools)) byGroup[groupId][tool] = permission(flags);
  }

  return { global, byGroup };
}

/** Every Prisma call dashboard.service.ts can make, each a plain vi.fn stub. */
function stubPrisma(overrides: Record<string, unknown> = {}) {
  const calls = {
    taskFindMany: vi.fn().mockResolvedValue([]),
    taskCount: vi.fn().mockResolvedValue(0),
    meetingFindMany: vi.fn().mockResolvedValue([]),
    groupMembershipFindMany: vi.fn().mockResolvedValue([]),
    accountRoleFindMany: vi.fn().mockResolvedValue([]),
    accountCount: vi.fn().mockResolvedValue(0),
    seasonFindFirst: vi.fn().mockResolvedValue(null),
    teamFindUnique: vi.fn().mockResolvedValue({ setupStage: "DONE" }),
    teamCount: vi.fn().mockResolvedValue(0),
    teamFindMany: vi.fn().mockResolvedValue([]),
    ...overrides,
  };

  const prisma = {
    task: { findMany: calls.taskFindMany, count: calls.taskCount },
    meeting: { findMany: calls.meetingFindMany },
    groupMembership: { findMany: calls.groupMembershipFindMany },
    accountRole: { findMany: calls.accountRoleFindMany },
    account: { count: calls.accountCount },
    season: { findFirst: calls.seasonFindFirst },
    team: { findUnique: calls.teamFindUnique, count: calls.teamCount, findMany: calls.teamFindMany },
  } as unknown as PrismaClient;

  return { prisma, calls };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("platform accounts", () => {
  it("never queries team data, and reads team counts only through TEAMS/read", async () => {
    mockedCanPerform.mockResolvedValue(true);
    const { prisma, calls } = stubPrisma({
      teamCount: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1),
      teamFindMany: vi.fn().mockResolvedValue([{ id: "t1", name: "A", createdAt: new Date(), setupStage: "DONE" }]),
    });

    const result = await createDashboardService(prisma).summary(account(null));

    expect(result).toMatchObject({ scope: "platform", tier: "platform" });
    expect(result.platform).toEqual({
      activeTeamCount: 3,
      archivedTeamCount: 1,
      recentTeams: [{ id: "t1", name: "A", createdAt: expect.any(Date), setupStage: "DONE" }],
    });
    expect(result.member).toBeNull();
    expect(result.lead).toBeNull();
    expect(result.teamAdmin).toBeNull();
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(calls.taskFindMany).not.toHaveBeenCalled();
    expect(calls.meetingFindMany).not.toHaveBeenCalled();
  });

  it("returns no platform block when the account cannot read TEAMS", async () => {
    mockedCanPerform.mockResolvedValue(false);
    const { prisma, calls } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account(null));

    expect(result.platform).toBeNull();
    expect(calls.teamCount).not.toHaveBeenCalled();
  });
});

describe("tier classification", () => {
  it("is team_admin only when ACCOUNTS is both readable and creatable team-wide", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canCreate: true } } }));
    const { prisma } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account());

    expect(result.tier).toBe("team_admin");
    expect(result.teamAdmin).not.toBeNull();
    expect(result.lead).toBeNull();
  });

  it("does not grant team_admin from ACCOUNTS read+update without create", async () => {
    // The seeded TEAM_LEAD role: can read and update accounts, cannot create
    // one, so it cannot actually do what the team-admin view is for.
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canUpdate: true } } }));
    const { prisma } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account());

    expect(result.tier).not.toBe("team_admin");
    expect(result.teamAdmin).toBeNull();
  });

  it("is lead when a team-wide role grants MEETINGS or TASKS write", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { MEETINGS: { canCreate: true } } }));
    const { prisma } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account());

    expect(result.tier).toBe("lead");
    expect(result.lead).not.toBeNull();
  });

  it("is lead when an in-group role grants MEETINGS write there", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { MEETINGS: { canCreate: true } } } }));
    const { prisma } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account());

    expect(result.tier).toBe("lead");
  });

  it("is member, not lead, from an in-group TASKS write grant alone", async () => {
    // The seeded MEMBER role: canCreate/canUpdate TASKS in its own group but
    // never MEETINGS. TASKS write alone must not read as organizing the group,
    // or every plain member would land on the lead view.
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { TASKS: { canCreate: true, canUpdate: true } } } }));
    const { prisma } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account());

    expect(result.tier).toBe("member");
    expect(result.lead).toBeNull();
  });

  it("falls back to member, with an empty roster, for a read-only or roleless account", async () => {
    // Exactly the seeded "nobody has decided where this one belongs yet"
    // account: a read-only floor role and no group. Must not be promoted to
    // lead by its placement alone, or this empty-state case breaks.
    mockedResolve.mockResolvedValue(matrix({ global: { TASKS: { canRead: true }, MEETINGS: { canRead: true } } }));
    const { prisma } = stubPrisma();

    const result = await createDashboardService(prisma).summary(account());

    expect(result.tier).toBe("member");
    expect(result.member).toMatchObject({ groups: [], roles: [] });
  });
});

describe("member data", () => {
  it("does not query tasks or meetings the account cannot read anywhere", async () => {
    mockedResolve.mockResolvedValue(matrix({}));
    const { prisma, calls } = stubPrisma();

    await createDashboardService(prisma).summary(account());

    expect(calls.taskFindMany).not.toHaveBeenCalled();
    expect(calls.meetingFindMany).not.toHaveBeenCalled();
  });

  it("queries every group at once for a group-scoped reader, not one call per group", async () => {
    mockedResolve.mockResolvedValue(
      matrix({ byGroup: { g1: { TASKS: { canRead: true } }, g2: { TASKS: { canRead: true } } } })
    );
    const { prisma, calls } = stubPrisma();

    await createDashboardService(prisma).summary(account());

    expect(calls.taskFindMany).toHaveBeenCalledTimes(1);
    expect(calls.taskFindMany.mock.calls[0]?.[0].where).toMatchObject({
      teamId: TEAM,
      groupId: { in: ["g1", "g2"] },
      assignees: { some: { accountId: ACCOUNT_ID } },
    });
  });

  it("queries team-wide with no group filter for a team-wide reader", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { TASKS: { canRead: true } } }));
    const { prisma, calls } = stubPrisma();

    await createDashboardService(prisma).summary(account());

    expect(calls.taskFindMany.mock.calls[0]?.[0].where).not.toHaveProperty("groupId");
  });

  it("splits assigned open tasks into due-in-the-future and overdue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    mockedResolve.mockResolvedValue(matrix({ global: { TASKS: { canRead: true } } }));
    const { prisma } = stubPrisma({
      taskFindMany: vi.fn().mockResolvedValue([
        { id: "future", name: "Future", status: "TODO", priority: "MEDIUM", dueDate: new Date("2026-09-20"), group: null },
        { id: "past", name: "Past", status: "TODO", priority: "MEDIUM", dueDate: new Date("2026-09-01"), group: null },
        { id: "undated", name: "Undated", status: "TODO", priority: "MEDIUM", dueDate: null, group: null },
      ]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.member?.openTasks.map((t) => t.id)).toEqual(["future", "undated"]);
    expect(result.member?.overdueTasks.map((t) => t.id)).toEqual(["past"]);
  });
});

describe("team_admin data", () => {
  it("counts active, pending-password, roleless and groupless accounts scoped to the team", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canCreate: true } } }));
    const accountCount = vi
      .fn()
      .mockResolvedValueOnce(12) // active
      .mockResolvedValueOnce(2) // must change password
      .mockResolvedValueOnce(1) // without role
      .mockResolvedValueOnce(3); // without group
    const { prisma } = stubPrisma({ accountCount });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.teamAdmin).toMatchObject({
      activeAccountCount: 12,
      mustChangePasswordCount: 2,
      withoutRoleCount: 1,
      withoutGroupCount: 3,
    });
    for (const call of accountCount.mock.calls) {
      expect(call[0].where).toMatchObject({ teamId: TEAM, archivedAt: null, isActive: true });
    }
  });

  it("flags an unfinished setup wizard", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canCreate: true } } }));
    const { prisma } = stubPrisma({ teamFindUnique: vi.fn().mockResolvedValue({ setupStage: "TOOLS" }) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.teamAdmin?.setupIncomplete).toBe(true);
  });
});

describe("authentication", () => {
  it("never leaks account data across a team boundary: every query is scoped to the caller's own team", async () => {
    mockedResolve.mockResolvedValue(
      matrix({
        global: { ACCOUNTS: { canRead: true, canCreate: true }, TASKS: { canRead: true }, MEETINGS: { canRead: true } },
      })
    );
    const { prisma, calls } = stubPrisma();

    await createDashboardService(prisma).summary(account("team-a"));

    expect(calls.taskFindMany.mock.calls[0]?.[0].where).toMatchObject({ teamId: "team-a" });
    expect(calls.meetingFindMany.mock.calls[0]?.[0].where).toMatchObject({ teamId: "team-a" });
    for (const call of calls.accountCount.mock.calls) {
      expect(call[0].where.teamId).toBe("team-a");
    }
  });
});
