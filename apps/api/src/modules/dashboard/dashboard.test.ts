import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import { EMPTY_PERMISSIONS, type PermissionSet } from "@breakpoint/types";

// dashboard.service.ts calls resolvePermissionMatrix/canPerform directly
// (rather than authorize(), which throws) -- both are already covered by
// authorize.test.ts, so this file stubs their *output* and tests only what
// this service does with it: which scopes a matrix produces, and which query
// each scope runs. A full Account/Role/GroupTool stub would only re-test
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
    meetingFindFirst: vi.fn().mockResolvedValue(null),
    groupFindMany: vi.fn().mockResolvedValue([]),
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
    meeting: { findMany: calls.meetingFindMany, findFirst: calls.meetingFindFirst },
    group: { findMany: calls.groupFindMany },
    groupMembership: { findMany: calls.groupMembershipFindMany },
    accountRole: { findMany: calls.accountRoleFindMany },
    account: { count: calls.accountCount },
    season: { findFirst: calls.seasonFindFirst },
    team: { findUnique: calls.teamFindUnique, count: calls.teamCount, findMany: calls.teamFindMany },
  } as unknown as PrismaClient;

  return { prisma, calls };
}

/** accountRole.findMany is called twice: once for "mine"'s role list, once for scope detection. */
function withRoles(roles: Array<{ placement: string; groupId: string | null }>) {
  return vi.fn().mockImplementation(({ select }: { select: Record<string, unknown> }) => {
    if ("role" in select && typeof select.role === "object" && select.role && "select" in select.role) {
      const roleSelect = (select.role as { select: Record<string, unknown> }).select;
      if ("placement" in roleSelect) {
        return Promise.resolve(roles.map((r) => ({ groupId: r.groupId, role: { placement: r.placement } })));
      }
    }
    return Promise.resolve([]);
  });
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

    expect(result.scope).toBe("platform");
    expect(result.platform).toEqual({
      activeTeamCount: 3,
      archivedTeamCount: 1,
      recentTeams: [{ id: "t1", name: "A", createdAt: expect.any(Date), setupStage: "DONE" }],
    });
    expect(result.mine).toBeNull();
    expect(result.group).toBeNull();
    expect(result.team).toBeNull();
    expect(result.management).toBeNull();
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

describe("scope detection", () => {
  it("gives management to a team-wide ACCOUNTS create grant, without needing group anchoring", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canCreate: true } } }));
    const { prisma } = stubPrisma({ accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management).not.toBeNull();
    expect(result.group).toBeNull();
  });

  it("gives management from an ACCOUNTS update grant alone -- update is still management authority", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canUpdate: true } } }));
    const { prisma } = stubPrisma({ accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management).not.toBeNull();
  });

  it("gives team scope from team-wide ACCOUNTS read alone, with no management and no group", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true } } }));
    const { prisma } = stubPrisma({ accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team).not.toBeNull();
    expect(result.management).toBeNull();
    expect(result.group).toBeNull();
  });

  it("does not give group scope from a merged team-wide MEETINGS grant alone -- a real group-anchored role is required", async () => {
    // The exact TEAM_ADMIN/MENTOR trap: a TEAM_WIDE role's grants are merged
    // into byGroup for every department, but that is not the same as running
    // one. Without a real IN_GROUP/MANAGES_GROUP assignment, "Grubum" must
    // not appear for every department in the team.
    mockedResolve.mockResolvedValue(
      matrix({
        global: { MEETINGS: { canCreate: true } },
        byGroup: { g1: { MEETINGS: { canCreate: true } }, g2: { MEETINGS: { canCreate: true } } },
      })
    );
    const { prisma } = stubPrisma({ accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group).toBeNull();
  });

  it("gives group scope for a real MANAGES_GROUP role with MEETINGS write at that department", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { MEETINGS: { canCreate: true } } } }));
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "MANAGES_GROUP", groupId: "g1" }]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Yazılım" }]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group).toEqual([
      expect.objectContaining({ groupId: "g1", groupName: "Yazılım" }),
    ]);
    expect(calls.groupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["g1"] } } })
    );
  });

  it("does not give group scope from an in-group TASKS write grant alone -- the seeded MEMBER role's baseline", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { TASKS: { canCreate: true, canUpdate: true } } } }));
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "IN_GROUP", groupId: "g1" }]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group).toBeNull();
  });

  it("covers more than one department for a two-group captain", async () => {
    mockedResolve.mockResolvedValue(
      matrix({ byGroup: { g1: { MEETINGS: { canCreate: true } }, g2: { MEETINGS: { canUpdate: true } } } })
    );
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([
        { placement: "MANAGES_GROUP", groupId: "g1" },
        { placement: "MANAGES_GROUP", groupId: "g2" },
      ]),
      groupFindMany: vi.fn().mockResolvedValue([
        { id: "g1", name: "Programming" },
        { id: "g2", name: "Electrical" },
      ]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group).toHaveLength(2);
  });

  it("gives none of group/team/management to a plain member, only mine", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { TASKS: { canRead: true, canCreate: true } } } }));
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "IN_GROUP", groupId: "g1" }]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.mine).not.toBeNull();
    expect(result.group).toBeNull();
    expect(result.team).toBeNull();
    expect(result.management).toBeNull();
  });

  it("gives every scope at once to an account that qualifies for all four", async () => {
    mockedResolve.mockResolvedValue(
      matrix({
        global: { ACCOUNTS: { canRead: true, canCreate: true } },
        byGroup: { g1: { MEETINGS: { canCreate: true } } },
      })
    );
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "MANAGES_GROUP", groupId: "g1" }]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Yazılım" }]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.mine).not.toBeNull();
    expect(result.group).not.toBeNull();
    expect(result.team).not.toBeNull();
    expect(result.management).not.toBeNull();
  });
});

describe("mine data", () => {
  it("does not query tasks or meetings the account cannot read anywhere", async () => {
    mockedResolve.mockResolvedValue(matrix({}));
    const { prisma, calls } = stubPrisma({ accountRoleFindMany: withRoles([]) });

    await createDashboardService(prisma).summary(account());

    expect(calls.taskFindMany).not.toHaveBeenCalled();
    expect(calls.meetingFindMany).not.toHaveBeenCalled();
  });

  it("queries every group at once for a group-scoped reader, not one call per group", async () => {
    mockedResolve.mockResolvedValue(
      matrix({ byGroup: { g1: { TASKS: { canRead: true } }, g2: { TASKS: { canRead: true } } } })
    );
    const { prisma, calls } = stubPrisma({ accountRoleFindMany: withRoles([]) });

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
    const { prisma, calls } = stubPrisma({ accountRoleFindMany: withRoles([]) });

    await createDashboardService(prisma).summary(account());

    expect(calls.taskFindMany.mock.calls[0]?.[0].where).not.toHaveProperty("groupId");
  });

  it("splits assigned open tasks into due-in-the-future and overdue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    mockedResolve.mockResolvedValue(matrix({ global: { TASKS: { canRead: true } } }));
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      taskFindMany: vi.fn().mockResolvedValue([
        { id: "future", name: "Future", status: "TODO", priority: "MEDIUM", dueDate: new Date("2026-09-20"), group: null },
        { id: "past", name: "Past", status: "TODO", priority: "MEDIUM", dueDate: new Date("2026-09-01"), group: null },
        { id: "undated", name: "Undated", status: "TODO", priority: "MEDIUM", dueDate: null, group: null },
      ]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.mine?.openTasks.map((t) => t.id)).toEqual(["future", "undated"]);
    expect(result.mine?.overdueTasks.map((t) => t.id)).toEqual(["past"]);
  });
});

describe("management data", () => {
  it("counts active, pending-password, roleless and groupless accounts scoped to the team", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canCreate: true } } }));
    const accountCount = vi
      .fn()
      .mockResolvedValueOnce(12) // active
      .mockResolvedValueOnce(2) // must change password
      .mockResolvedValueOnce(1) // without role
      .mockResolvedValueOnce(3); // without group
    const { prisma } = stubPrisma({ accountCount, accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management).toMatchObject({
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
    const { prisma } = stubPrisma({
      teamFindUnique: vi.fn().mockResolvedValue({ setupStage: "TOOLS" }),
      accountRoleFindMany: withRoles([]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management?.setupIncomplete).toBe(true);
  });

  // Any of ACCOUNTS/ROLES/GROUPS/SEASONS create/update/delete unlocks the
  // "Yönetim" tab (see computeScopes), but ACCOUNTS/read is a separate grant
  // -- a role holding only ROLES: cud has no visibility into the roster at
  // all. The account-health counts must not appear just because the tab is
  // visible, the same as GET /accounts would refuse this account.
  it("does not leak account counts when only a non-ACCOUNTS management grant unlocks the tab", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ROLES: { canCreate: true } } }));
    const accountCount = vi.fn().mockResolvedValue(99);
    const { prisma, calls } = stubPrisma({ accountCount, accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management).toMatchObject({
      activeAccountCount: 0,
      mustChangePasswordCount: 0,
      withoutRoleCount: 0,
      withoutGroupCount: 0,
    });
    expect(calls.accountCount).not.toHaveBeenCalled();
  });

  // Same shape, for SEASONS: an ACCOUNTS-only admin unlocks "Yönetim" and can
  // read the roster, but has no SEASONS grant and must not see the season
  // that gates it, the same as GET /seasons would refuse this account.
  it("does not leak the active season when the account cannot read SEASONS", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true, canCreate: true } } }));
    const seasonFindFirst = vi.fn().mockResolvedValue({ id: "s1", name: "2026 Season", startDate: new Date(), endDate: new Date() });
    const { prisma, calls } = stubPrisma({ seasonFindFirst, accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management?.activeSeason).toBeNull();
    expect(calls.seasonFindFirst).not.toHaveBeenCalled();
  });

  it("shows the active season with team-wide SEASONS read", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { SEASONS: { canRead: true, canCreate: true } } }));
    const season = { id: "s1", name: "2026 Season", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") };
    const { prisma } = stubPrisma({
      seasonFindFirst: vi.fn().mockResolvedValue(season),
      accountRoleFindMany: withRoles([]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.management?.activeSeason).toEqual(season);
  });
});

describe("team data", () => {
  it("computes a per-department open/overdue/unassigned table for every active group the account can read TASKS in", async () => {
    mockedResolve.mockResolvedValue(
      matrix({ global: { ACCOUNTS: { canRead: true }, TASKS: { canRead: true } } })
    );
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Mechanical" }]),
      taskCount: vi.fn().mockResolvedValue(2),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team?.departments).toEqual([
      { groupId: "g1", groupName: "Mechanical", openCount: 2, overdueCount: 2, unassignedCount: 2 },
    ]);
    expect(calls.groupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: TEAM, isActive: true } })
    );
  });

  // ACCOUNTS/read is what unlocks the "Takım" tab (see computeScopes), and it
  // is a separate grant from TASKS/read -- an admin can and does set them
  // independently. A department's task counts must not appear just because
  // the tab itself is visible, the same as GET /tasks?groupId=g1 would refuse
  // this account with no TASKS grant on g1.
  it("does not leak a department's task counts when the account cannot read TASKS there", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true } } }));
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Mechanical" }]),
      taskCount: vi.fn().mockResolvedValue(2),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team?.departments).toEqual([
      { groupId: "g1", groupName: "Mechanical", openCount: 0, overdueCount: 0, unassignedCount: 0 },
    ]);
    expect(calls.taskCount).not.toHaveBeenCalled();
  });

  it("leaks counts only for the specific departments a group-scoped TASKS reader can see, not every department", async () => {
    mockedResolve.mockResolvedValue(
      matrix({
        global: { ACCOUNTS: { canRead: true } },
        byGroup: { g1: { TASKS: { canRead: true } } },
      })
    );
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      groupFindMany: vi.fn().mockResolvedValue([
        { id: "g1", name: "Mechanical" },
        { id: "g2", name: "Electrical" },
      ]),
      taskCount: vi.fn().mockResolvedValue(2),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team?.departments).toEqual([
      { groupId: "g1", groupName: "Mechanical", openCount: 2, overdueCount: 2, unassignedCount: 2 },
      { groupId: "g2", groupName: "Electrical", openCount: 0, overdueCount: 0, unassignedCount: 0 },
    ]);
  });

  it("does not query cross-group task counts without team-wide TASKS read", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true } } }));
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      groupFindMany: vi.fn().mockResolvedValue([]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team).toMatchObject({ crossGroupOpenTaskCount: 0, crossGroupUnassignedTaskCount: 0 });
    expect(calls.taskCount).not.toHaveBeenCalled();
  });

  it("does query cross-group task counts with team-wide TASKS read", async () => {
    mockedResolve.mockResolvedValue(
      matrix({ global: { ACCOUNTS: { canRead: true }, TASKS: { canRead: true } } })
    );
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      groupFindMany: vi.fn().mockResolvedValue([]),
      taskCount: vi.fn().mockResolvedValue(5),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team).toMatchObject({ crossGroupOpenTaskCount: 5, crossGroupUnassignedTaskCount: 5 });
    expect(calls.taskCount.mock.calls.some((call) => call[0]?.where?.groupId === null)).toBe(true);
  });

  // ACCOUNTS/read is what unlocks "Takım" (see computeScopes) and says
  // nothing about SEASONS, a separate grant an admin sets independently. The
  // active season must not appear just because the tab is visible, the same
  // as GET /seasons would refuse this account.
  it("does not leak the active season without team-wide SEASONS read", async () => {
    mockedResolve.mockResolvedValue(matrix({ global: { ACCOUNTS: { canRead: true } } }));
    const seasonFindFirst = vi.fn().mockResolvedValue({ id: "s1", name: "2026 Season", endDate: new Date("2026-12-31") });
    const { prisma, calls } = stubPrisma({ seasonFindFirst, accountRoleFindMany: withRoles([]) });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team).toMatchObject({ activeSeason: null, seasonDaysRemaining: null });
    expect(calls.seasonFindFirst).not.toHaveBeenCalled();
  });

  it("shows the active season with team-wide SEASONS read", async () => {
    mockedResolve.mockResolvedValue(
      matrix({ global: { ACCOUNTS: { canRead: true }, SEASONS: { canRead: true } } })
    );
    const season = { id: "s1", name: "2026 Season", endDate: new Date("2026-12-31") };
    const { prisma } = stubPrisma({
      seasonFindFirst: vi.fn().mockResolvedValue(season),
      accountRoleFindMany: withRoles([]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.team?.activeSeason).toEqual(season);
    expect(result.team?.seasonDaysRemaining).not.toBeNull();
  });
});

describe("group data", () => {
  it("computes real task counts and top tasks for a department the account can read TASKS in", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { MEETINGS: { canCreate: true }, TASKS: { canRead: true } } } }));
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "MANAGES_GROUP", groupId: "g1" }]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Yazılım" }]),
      taskCount: vi.fn().mockResolvedValue(3),
      taskFindMany: vi.fn().mockResolvedValue([
        { id: "t1", name: "Task", status: "TODO", priority: "MEDIUM", dueDate: null, group: { name: "Yazılım" } },
      ]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group?.[0]).toMatchObject({ groupId: "g1", openCount: 3, overdueCount: 3, unassignedCount: 3 });
    expect(result.group?.[0]?.topTasks).toHaveLength(1);
    expect(calls.taskFindMany).toHaveBeenCalled();
  });

  // "Grubum" is unlocked by running the department (a real group-anchored
  // role with MEETINGS write there -- see computeScopes), not by holding
  // TASKS there. The two are independent grants, so a lead who runs a
  // department on MEETINGS alone must see the same nothing GET
  // /tasks?groupId=g1 would answer with -- not the department's real task
  // names, priorities and due dates.
  it("does not leak a department's task names or counts when the account cannot read TASKS there", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { MEETINGS: { canCreate: true } } } }));
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "MANAGES_GROUP", groupId: "g1" }]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Yazılım" }]),
      taskCount: vi.fn().mockResolvedValue(3),
      taskFindMany: vi.fn().mockResolvedValue([
        { id: "t1", name: "Secret task", status: "TODO", priority: "MEDIUM", dueDate: null, group: { name: "Yazılım" } },
      ]),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group?.[0]).toMatchObject({
      groupId: "g1",
      openCount: 0,
      overdueCount: 0,
      unassignedCount: 0,
      completedThisWeekCount: 0,
      topTasks: [],
    });
    expect(calls.taskCount).not.toHaveBeenCalled();
    expect(calls.taskFindMany).not.toHaveBeenCalled();
  });

  it("still shows the department's upcoming meeting even without TASKS read -- MEETINGS is what unlocked the tab", async () => {
    mockedResolve.mockResolvedValue(matrix({ byGroup: { g1: { MEETINGS: { canCreate: true } } } }));
    const { prisma } = stubPrisma({
      accountRoleFindMany: withRoles([{ placement: "MANAGES_GROUP", groupId: "g1" }]),
      groupFindMany: vi.fn().mockResolvedValue([{ id: "g1", name: "Yazılım" }]),
      meetingFindFirst: vi.fn().mockResolvedValue({
        id: "m1",
        title: "Standup",
        meetingDate: new Date("2026-09-20"),
        group: { name: "Yazılım" },
      }),
    });

    const result = await createDashboardService(prisma).summary(account());

    expect(result.group?.[0]?.upcomingMeeting).toMatchObject({ id: "m1", title: "Standup" });
  });
});

describe("authentication", () => {
  it("never leaks account data across a team boundary: every query is scoped to the caller's own team", async () => {
    mockedResolve.mockResolvedValue(
      matrix({
        global: { ACCOUNTS: { canRead: true, canCreate: true }, TASKS: { canRead: true }, MEETINGS: { canRead: true } },
      })
    );
    const { prisma, calls } = stubPrisma({
      accountRoleFindMany: withRoles([]),
      groupFindMany: vi.fn().mockResolvedValue([]),
    });

    await createDashboardService(prisma).summary(account("team-a"));

    expect(calls.taskFindMany.mock.calls[0]?.[0].where).toMatchObject({ teamId: "team-a" });
    expect(calls.meetingFindMany.mock.calls[0]?.[0].where).toMatchObject({ teamId: "team-a" });
    for (const call of calls.accountCount.mock.calls) {
      expect(call[0].where.teamId).toBe("team-a");
    }
  });
});
