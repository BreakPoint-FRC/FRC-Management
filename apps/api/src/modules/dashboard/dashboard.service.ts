import type { Prisma, PrismaClient } from "@breakpoint/db";
import { OPEN_TASK_STATUSES } from "@breakpoint/types";

import { canPerform, resolvePermissionMatrix } from "../../lib/authorize";
import type { AuthenticatedAccount } from "../../plugins/auth";

const DAY = 24 * 60 * 60 * 1000;
const UPCOMING_MEETING_WINDOW = 7 * DAY;
const RECENT_WINDOW = 7 * DAY;
const LIST_LIMIT = 5;

/**
 * UTC midnight of `now`'s calendar day.
 *
 * dueDate/meetingDate are date-only columns, always stored as UTC midnight of
 * the day they name (see meetings.schema.ts's z.coerce.date()). Comparing them
 * against the raw `now` instant treats "today" as already over/started the
 * moment local time passes that midnight -- east of Greenwich that is nearly
 * the whole day, so a task due today reads as overdue and today's meeting
 * drops out of "upcoming" for most of the day it is actually happening on.
 * Comparing against this boundary instead keeps both correct for their whole
 * calendar day.
 */
function startOfToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const taskSummarySelect = {
  id: true,
  name: true,
  status: true,
  priority: true,
  dueDate: true,
  group: { select: { name: true } },
} satisfies Prisma.TaskSelect;

const meetingSummarySelect = {
  id: true,
  title: true,
  meetingDate: true,
  group: { select: { name: true } },
} satisfies Prisma.MeetingSelect;

function serializeTask(task: Prisma.TaskGetPayload<{ select: typeof taskSummarySelect }>) {
  const { group, ...rest } = task;
  return { ...rest, groupName: group?.name ?? null };
}

function serializeMeeting(meeting: Prisma.MeetingGetPayload<{ select: typeof meetingSummarySelect }>) {
  const { group, ...rest } = meeting;
  return { ...rest, groupName: group?.name ?? null };
}

/**
 * The groups a resolved permission matrix says this tool is readable in,
 * split into "everywhere" (a TEAM_WIDE/EXTERNAL role) and a specific list.
 *
 * Mirrors what calendar.routes.ts and tasks.routes.ts each ask `authorize` one
 * group at a time -- this asks once, for every group, which is what a
 * dashboard needs and a single client request could not get any other way.
 */
function readableScope(
  matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>,
  tool: "TASKS" | "MEETINGS"
): { teamWide: boolean; groupIds: string[] } {
  const teamWide = matrix.global[tool]?.canRead ?? false;
  const groupIds = teamWide
    ? []
    : Object.entries(matrix.byGroup)
        .filter(([, perTool]) => perTool[tool]?.canRead)
        .map(([groupId]) => groupId);
  return { teamWide, groupIds };
}

/** Shared by Task and Meeting, both of which filter on this same column. */
function scopeWhere(scope: { teamWide: boolean; groupIds: string[] }): { groupId?: { in: string[] } } | null {
  if (scope.teamWide) return {};
  if (scope.groupIds.length > 0) return { groupId: { in: scope.groupIds } };
  return null;
}

const MANAGEMENT_TOOLS = ["ACCOUNTS", "ROLES", "GROUPS", "SEASONS"] as const;

/**
 * Which of the four scope tabs this account gets -- never mutually exclusive.
 * A software captain who is also the team captain and a finance reader gets
 * all three tabs at once, because that is a real, ordinary combination of
 * roles the OR-merged permission model already produces.
 *
 * "Benim" is unconditional. The other three are decided from the same
 * resolved matrix `authorize()` trusts, never from a role's name:
 *
 * - "Grubum" needs an actually group-anchored role (IN_GROUP or
 *   MANAGES_GROUP placement, so a real department assignment exists) whose
 *   resolved grant at that specific department includes MEETINGS write. A
 *   TEAM_WIDE role's grants are merged into every group's entry in `byGroup`
 *   too, so scanning `byGroup` alone -- without first checking that the
 *   account holds a real, group-scoped assignment there -- would hand a
 *   TEAM_ADMIN or a MENTOR a "Grubum" tab for every single department in the
 *   team, which is not a department they run.
 * - "Takım" is team-wide ACCOUNTS read: what a captain, a mentor and every
 *   admin-flavoured role have in common is visibility into the whole
 *   roster, not just their own group's.
 * - "Yönetim" is any team-wide create/update/delete on ACCOUNTS, ROLES,
 *   GROUPS or SEASONS -- literally "authority to manage an account, a role,
 *   a group or a season", matching the roadmap's own wording rather than a
 *   narrower single-tool heuristic.
 */
function computeScopes(
  matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>,
  myGroupRoles: readonly { placement: string; groupId: string | null }[]
): { groupIds: string[]; team: boolean; management: boolean } {
  const anchoredGroupIds = [
    ...new Set(
      myGroupRoles
        .filter((role) => (role.placement === "IN_GROUP" || role.placement === "MANAGES_GROUP") && role.groupId)
        .map((role) => role.groupId as string)
    ),
  ];
  const groupIds = anchoredGroupIds.filter(
    (groupId) => matrix.byGroup[groupId]?.MEETINGS?.canCreate || matrix.byGroup[groupId]?.MEETINGS?.canUpdate
  );

  const team = matrix.global.ACCOUNTS?.canRead ?? false;
  const management = MANAGEMENT_TOOLS.some((tool) => {
    const set = matrix.global[tool];
    return set?.canCreate || set?.canUpdate || set?.canDelete;
  });

  return { groupIds, team, management };
}

export function createDashboardService(prisma: PrismaClient) {
  const platformSummary = async (accountId: string) => {
    if (!(await canPerform(prisma, { accountId, tool: "TEAMS", action: "read" }))) return null;

    const [activeTeamCount, archivedTeamCount, recentTeams] = await Promise.all([
      prisma.team.count({ where: { isActive: true } }),
      prisma.team.count({ where: { isActive: false } }),
      prisma.team.findMany({
        orderBy: { createdAt: "desc" },
        take: LIST_LIMIT,
        select: { id: true, name: true, createdAt: true, setupStage: true },
      }),
    ]);

    return { activeTeamCount, archivedTeamCount, recentTeams };
  };

  /** "Benim": always computed, the same for every signed-in team account. */
  const mineSummary = async (
    teamId: string,
    accountId: string,
    matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>
  ) => {
    const now = new Date();
    const todayStart = startOfToday(now);

    const taskWhere = scopeWhere(readableScope(matrix, "TASKS"));
    const meetingWhere = scopeWhere(readableScope(matrix, "MEETINGS"));

    // Overdue and open-but-not-yet-due are fetched as two separately bounded
    // queries rather than one `take` fetch split client-side afterward.
    // Ascending due-date sort means every overdue task -- unbounded, however
    // many exist -- sorts before every not-yet-due one, so a single
    // `take: LIST_LIMIT * 2` could be entirely consumed by overdue rows and
    // silently return zero upcoming tasks even when real ones exist.
    const assignedTaskWhere = taskWhere && {
      ...taskWhere,
      teamId,
      status: { in: [...OPEN_TASK_STATUSES] },
      assignees: { some: { accountId } },
    };

    const [overdueTasks, openTasks, upcomingMeetings, groups, roles] = await Promise.all([
      assignedTaskWhere
        ? prisma.task.findMany({
            where: { ...assignedTaskWhere, dueDate: { lt: todayStart } },
            select: taskSummarySelect,
            orderBy: { dueDate: "asc" },
            take: LIST_LIMIT,
          })
        : Promise.resolve([]),
      assignedTaskWhere
        ? prisma.task.findMany({
            where: { ...assignedTaskWhere, OR: [{ dueDate: null }, { dueDate: { gte: todayStart } }] },
            select: taskSummarySelect,
            orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
            take: LIST_LIMIT,
          })
        : Promise.resolve([]),
      meetingWhere
        ? prisma.meeting.findMany({
            where: {
              ...meetingWhere,
              teamId,
              meetingDate: { gte: todayStart, lte: new Date(todayStart.getTime() + UPCOMING_MEETING_WINDOW) },
            },
            select: meetingSummarySelect,
            orderBy: { meetingDate: "asc" },
            take: LIST_LIMIT,
          })
        : Promise.resolve([]),
      prisma.groupMembership.findMany({
        where: { accountId, isActive: true },
        select: { group: { select: { id: true, name: true } } },
      }),
      prisma.accountRole.findMany({
        where: { accountId, isActive: true },
        select: { role: { select: { name: true } }, group: { select: { name: true } } },
      }),
    ]);

    return {
      openTasks: openTasks.map(serializeTask),
      overdueTasks: overdueTasks.map(serializeTask),
      upcomingMeetings: upcomingMeetings.map(serializeMeeting),
      groups: groups.map((entry) => entry.group),
      roles: roles.map((entry) => ({
        roleName: entry.role.name,
        groupName: entry.group?.name ?? null,
      })),
    };
  };

  /**
   * "Grubum": one block per department the account actually runs (a real
   * IN_GROUP/MANAGES_GROUP assignment with MEETINGS write there -- see
   * computeScopes). Plural on purpose: a person can captain more than one
   * department at once, same as the seeded "iki departmanin lead'i" case.
   *
   * Running a department is what unlocks the tab; it is not what unlocks its
   * task fields. A department's task names, priorities and due dates are
   * TASKS data, and MEETINGS write is a different grant -- a lead who runs a
   * department on MEETINGS alone (TASKS never granted, or switched off for
   * that group via GroupTool) must see the same nothing here that
   * GET /tasks?groupId=that would answer with. `taskScope` is the same
   * `readableScope(matrix, "TASKS")` mineSummary already uses.
   */
  const groupSummary = async (
    teamId: string,
    groupIds: readonly string[],
    taskScope: { teamWide: boolean; groupIds: readonly string[] },
    meetingScope: { teamWide: boolean; groupIds: readonly string[] }
  ) => {
    const now = new Date();
    const todayStart = startOfToday(now);
    const weekAgo = new Date(now.getTime() - RECENT_WINDOW);

    const groups = await prisma.group.findMany({
      where: { id: { in: [...groupIds] } },
      select: { id: true, name: true },
    });

    return Promise.all(
      groups.map(async (group) => {
        const canReadTasks = taskScope.teamWide || taskScope.groupIds.includes(group.id);
        const canReadMeetings = meetingScope.teamWide || meetingScope.groupIds.includes(group.id);

        const [openCount, overdueCount, unassignedCount, completedThisWeekCount, topTasks, upcomingMeeting] =
          await Promise.all([
            canReadTasks
              ? prisma.task.count({
                  where: { teamId, groupId: group.id, status: { in: [...OPEN_TASK_STATUSES] } },
                })
              : Promise.resolve(0),
            canReadTasks
              ? prisma.task.count({
                  where: {
                    teamId,
                    groupId: group.id,
                    status: { in: [...OPEN_TASK_STATUSES] },
                    dueDate: { lt: todayStart },
                  },
                })
              : Promise.resolve(0),
            canReadTasks
              ? prisma.task.count({
                  where: {
                    teamId,
                    groupId: group.id,
                    status: { in: [...OPEN_TASK_STATUSES] },
                    assignees: { none: {} },
                  },
                })
              : Promise.resolve(0),
            canReadTasks
              ? prisma.task.count({
                  where: { teamId, groupId: group.id, status: "COMPLETED", updatedAt: { gte: weekAgo } },
                })
              : Promise.resolve(0),
            canReadTasks
              ? prisma.task.findMany({
                  where: { teamId, groupId: group.id, status: { in: [...OPEN_TASK_STATUSES] } },
                  select: taskSummarySelect,
                  orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
                  take: LIST_LIMIT,
                })
              : Promise.resolve([]),
            canReadMeetings
              ? prisma.meeting.findFirst({
                  where: { teamId, groupId: group.id, meetingDate: { gte: todayStart } },
                  select: meetingSummarySelect,
                  orderBy: { meetingDate: "asc" },
                })
              : Promise.resolve(null),
          ]);

        return {
          groupId: group.id,
          groupName: group.name,
          canReadTasks,
          canReadMeetings,
          openCount,
          overdueCount,
          unassignedCount,
          completedThisWeekCount,
          topTasks: topTasks.map(serializeTask),
          upcomingMeeting: upcomingMeeting ? serializeMeeting(upcomingMeeting) : null,
        };
      })
    );
  };

  /**
   * "Takım": the whole team's shape, for a captain, mentor or admin-flavoured
   * role reading across departments rather than running just one.
   *
   * Gated on team-wide ACCOUNTS read (see computeScopes), which says nothing
   * about TASKS -- the two are independent grants an admin can and does set
   * separately. Every task field below is therefore additionally scoped by
   * `taskScope`, the same `readableScope(matrix, "TASKS")` mineSummary already
   * uses: a cross-group count needs team-wide TASKS read (a scoped reader
   * cannot see a task naming no department at all, same as GET /tasks would
   * answer), and each department's counts need TASKS read for that specific
   * department.
   */
  const teamSummary = async (teamId: string, matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>) => {
    const now = new Date();
    const todayStart = startOfToday(now);
    const meetingWhere = scopeWhere(readableScope(matrix, "MEETINGS"));
    const taskScope = readableScope(matrix, "TASKS");
    const canReadSeasons = matrix.global.SEASONS?.canRead ?? false;

    // Department names are GROUPS data in the dedicated API, but task rows
    // also legitimately reveal the group they belong to. This dashboard needs
    // only departments whose task aggregates the caller may read, so do not
    // enumerate every group merely because ACCOUNTS/read unlocked the tab.
    const readableTaskGroups = taskScope.teamWide
      ? undefined
      : taskScope.groupIds.length > 0
        ? { id: { in: taskScope.groupIds } }
        : null;

    const [groups, activeSeason, upcomingMeeting, crossGroupOpenCount, crossGroupUnassignedCount] =
      await Promise.all([
        readableTaskGroups === null
          ? Promise.resolve([])
          : prisma.group.findMany({
              where: { teamId, isActive: true, ...readableTaskGroups },
              select: { id: true, name: true },
            }),
        canReadSeasons
          ? prisma.season.findFirst({
              where: { teamId, isActive: true },
              select: { id: true, name: true, endDate: true },
            })
          : Promise.resolve(null),
        meetingWhere
          ? prisma.meeting.findFirst({
              where: { ...meetingWhere, teamId, meetingDate: { gte: todayStart } },
              select: meetingSummarySelect,
              orderBy: { meetingDate: "asc" },
            })
          : Promise.resolve(null),
        taskScope.teamWide
          ? prisma.task.count({ where: { teamId, status: { in: [...OPEN_TASK_STATUSES] }, groupId: null } })
          : Promise.resolve(0),
        taskScope.teamWide
          ? prisma.task.count({
              where: {
                teamId,
                status: { in: [...OPEN_TASK_STATUSES] },
                groupId: null,
                assignees: { none: {} },
              },
            })
          : Promise.resolve(0),
      ]);

    const departments = await Promise.all(
      groups.map(async (group) => {
        const canReadTasks = taskScope.teamWide || taskScope.groupIds.includes(group.id);
        if (!canReadTasks) {
          return { groupId: group.id, groupName: group.name, openCount: 0, overdueCount: 0, unassignedCount: 0 };
        }

        const [openCount, overdueCount, unassignedCount] = await Promise.all([
          prisma.task.count({
            where: { teamId, groupId: group.id, status: { in: [...OPEN_TASK_STATUSES] } },
          }),
          prisma.task.count({
            where: {
              teamId,
              groupId: group.id,
              status: { in: [...OPEN_TASK_STATUSES] },
              dueDate: { lt: todayStart },
            },
          }),
          prisma.task.count({
            where: {
              teamId,
              groupId: group.id,
              status: { in: [...OPEN_TASK_STATUSES] },
              assignees: { none: {} },
            },
          }),
        ]);
        return { groupId: group.id, groupName: group.name, openCount, overdueCount, unassignedCount };
      })
    );

    return {
      canReadTasks: taskScope.teamWide || taskScope.groupIds.length > 0,
      canReadCrossGroupTasks: taskScope.teamWide,
      canReadSeasons,
      canReadMeetings: meetingWhere !== null,
      departments,
      activeSeason,
      seasonDaysRemaining: activeSeason
        ? Math.max(0, Math.ceil((activeSeason.endDate.getTime() - now.getTime()) / DAY))
        : null,
      upcomingMeeting: upcomingMeeting ? serializeMeeting(upcomingMeeting) : null,
      crossGroupOpenTaskCount: crossGroupOpenCount,
      crossGroupUnassignedTaskCount: crossGroupUnassignedCount,
    };
  };

  /**
   * "Yönetim": a container for management health, not a permission bypass.
   *
   * The tab is intentionally available to someone who manages any one of
   * ACCOUNTS/ROLES/GROUPS/SEASONS. Its cards are not interchangeable though:
   * role management must not disclose account counts, and group management
   * must not disclose the active season. Each family is therefore nullable
   * unless its own read grant is present.
   */
  const managementSummary = async (
    teamId: string,
    matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>
  ) => {
    const canReadAccounts = matrix.global.ACCOUNTS?.canRead ?? false;
    const canReadSeasons = matrix.global.SEASONS?.canRead ?? false;
    const [team, activeAccountCount, mustChangePasswordCount, withoutRoleCount, withoutGroupCount, activeSeason] =
      await Promise.all([
        prisma.team.findUnique({ where: { id: teamId }, select: { setupStage: true } }),
        canReadAccounts
          ? prisma.account.count({ where: { teamId, archivedAt: null, isActive: true } })
          : Promise.resolve(null),
        canReadAccounts
          ? prisma.account.count({
              where: { teamId, archivedAt: null, isActive: true, mustChangePassword: true },
            })
          : Promise.resolve(null),
        canReadAccounts
          ? prisma.account.count({
              where: { teamId, archivedAt: null, isActive: true, roles: { none: { isActive: true } } },
            })
          : Promise.resolve(null),
        canReadAccounts
          ? prisma.account.count({
              where: {
                teamId,
                archivedAt: null,
                isActive: true,
                memberships: { none: { isActive: true } },
              },
            })
          : Promise.resolve(null),
        canReadSeasons
          ? prisma.season.findFirst({
              where: { teamId, isActive: true },
              select: { id: true, name: true, startDate: true, endDate: true },
            })
          : Promise.resolve(null),
      ]);

    return {
      canReadAccounts,
      canReadSeasons,
      activeAccountCount,
      mustChangePasswordCount,
      withoutRoleCount,
      withoutGroupCount,
      activeSeason,
      setupIncomplete: team?.setupStage !== "DONE",
    };
  };

  return {
    summary: async (account: AuthenticatedAccount) => {
      if (account.teamId === null) {
        return {
          scope: "platform" as const,
          platform: await platformSummary(account.id),
          mine: null,
          group: null,
          team: null,
          management: null,
        };
      }

      const teamId = account.teamId;
      const [matrix, accountRoles] = await Promise.all([
        resolvePermissionMatrix(prisma, account.id),
        prisma.accountRole.findMany({
          where: { accountId: account.id, isActive: true },
          select: { groupId: true, role: { select: { placement: true } } },
        }),
      ]);

      const scopes = computeScopes(
        matrix,
        accountRoles.map((entry) => ({ placement: entry.role.placement, groupId: entry.groupId }))
      );

      const [mine, group, team, management] = await Promise.all([
        mineSummary(teamId, account.id, matrix),
        scopes.groupIds.length > 0
          ? groupSummary(
              teamId,
              scopes.groupIds,
              readableScope(matrix, "TASKS"),
              readableScope(matrix, "MEETINGS")
            )
          : Promise.resolve(null),
        scopes.team ? teamSummary(teamId, matrix) : Promise.resolve(null),
        scopes.management ? managementSummary(teamId, matrix) : Promise.resolve(null),
      ]);

      return { scope: "team" as const, platform: null, mine, group, team, management };
    },
  };
}
