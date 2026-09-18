import type { Prisma, PrismaClient } from "@breakpoint/db";
import { OPEN_TASK_STATUSES } from "@breakpoint/types";

import { canPerform, resolvePermissionMatrix } from "../../lib/authorize";
import type { AuthenticatedAccount } from "../../plugins/auth";

const DAY = 24 * 60 * 60 * 1000;
const UPCOMING_MEETING_WINDOW = 7 * DAY;
const LIST_LIMIT = 5;

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
 * dashboard needs and a single client request could not get any other way
 * (see the roadmap note this endpoint exists to answer).
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

/**
 * Which of the four dashboard views this account gets, decided from the same
 * permission rows `authorize()` already trusts -- never from a role's name.
 *
 * team_admin: can actually read and create accounts team-wide. TEAM_LEAD in
 * the seeded set holds ACCOUNTS read+update but not create and lands in
 * "lead" instead, which matches what it can actually do.
 *
 * lead: either a TEAM_WIDE/EXTERNAL role grants TASKS or MEETINGS write
 * somewhere, or an IN_GROUP role grants MEETINGS write in some group -- the
 * seeded MEMBER role grants TASKS write in its own group same as LEAD does,
 * so TASKS alone cannot tell the two apart; MEETINGS write is what a group's
 * organizer holds and a plain member does not.
 *
 * A read-only TEAM_WIDE/EXTERNAL role (the seeded MENTOR, or a bare
 * TEAM_MEMBER floor role with nothing else attached) satisfies neither check
 * and falls through to "member". That undersells an actual mentor, who
 * reasonably belongs beside a lead, but the alternative -- reading a role's
 * name or placement alone -- misclassifies the exact case this dashboard has
 * to get right: an account holding only the floor role nobody has assigned
 * anywhere yet, which must land on the empty-state "member" view and not on
 * an aggregate admin-style one it has no data behind.
 */
function classify(
  account: AuthenticatedAccount,
  matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>
): "platform" | "team_admin" | "lead" | "member" {
  if (account.teamId === null) return "platform";

  const accounts = matrix.global.ACCOUNTS;
  if (accounts?.canRead && accounts?.canCreate) return "team_admin";

  const teamWideLead =
    matrix.global.TASKS?.canCreate ||
    matrix.global.TASKS?.canUpdate ||
    matrix.global.MEETINGS?.canCreate ||
    matrix.global.MEETINGS?.canUpdate;
  const groupLead = Object.values(matrix.byGroup).some(
    (perTool) => perTool.MEETINGS?.canCreate || perTool.MEETINGS?.canUpdate
  );

  return teamWideLead || groupLead ? "lead" : "member";
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

  const memberSummary = async (
    teamId: string,
    accountId: string,
    matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>
  ) => {
    const now = new Date();

    const taskWhere = scopeWhere(readableScope(matrix, "TASKS"));
    const meetingWhere = scopeWhere(readableScope(matrix, "MEETINGS"));

    const [openTasks, upcomingMeetings, groups, roles] = await Promise.all([
      taskWhere
        ? prisma.task.findMany({
            where: {
              ...taskWhere,
              teamId,
              status: { in: [...OPEN_TASK_STATUSES] },
              assignees: { some: { accountId } },
            },
            select: taskSummarySelect,
            orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
            take: LIST_LIMIT * 2,
          })
        : Promise.resolve([]),
      meetingWhere
        ? prisma.meeting.findMany({
            where: {
              ...meetingWhere,
              teamId,
              meetingDate: { gte: now, lte: new Date(now.getTime() + UPCOMING_MEETING_WINDOW) },
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

    const serialized = openTasks.map(serializeTask);
    const overdue = serialized.filter((task) => task.dueDate !== null && task.dueDate < now);
    const open = serialized.filter((task) => task.dueDate === null || task.dueDate >= now);

    return {
      openTasks: open.slice(0, LIST_LIMIT),
      overdueTasks: overdue.slice(0, LIST_LIMIT),
      upcomingMeetings: upcomingMeetings.map(serializeMeeting),
      groups: groups.map((entry) => entry.group),
      roles: roles.map((entry) => ({
        roleName: entry.role.name,
        groupName: entry.group?.name ?? null,
      })),
    };
  };

  const leadSummary = async (
    teamId: string,
    matrix: Awaited<ReturnType<typeof resolvePermissionMatrix>>
  ) => {
    const now = new Date();
    const taskWhere = scopeWhere(readableScope(matrix, "TASKS"));
    if (!taskWhere) return { teamOpenTaskCount: 0, teamOverdueTaskCount: 0 };

    const [teamOpenTaskCount, teamOverdueTaskCount] = await Promise.all([
      prisma.task.count({
        where: { ...taskWhere, teamId, status: { in: [...OPEN_TASK_STATUSES] } },
      }),
      prisma.task.count({
        where: {
          ...taskWhere,
          teamId,
          status: { in: [...OPEN_TASK_STATUSES] },
          dueDate: { lt: now },
        },
      }),
    ]);

    return { teamOpenTaskCount, teamOverdueTaskCount };
  };

  const teamAdminSummary = async (teamId: string) => {
    const [team, activeAccountCount, mustChangePasswordCount, withoutRoleCount, withoutGroupCount, activeSeason] =
      await Promise.all([
        prisma.team.findUnique({ where: { id: teamId }, select: { setupStage: true } }),
        prisma.account.count({ where: { teamId, archivedAt: null, isActive: true } }),
        prisma.account.count({
          where: { teamId, archivedAt: null, isActive: true, mustChangePassword: true },
        }),
        prisma.account.count({
          where: { teamId, archivedAt: null, isActive: true, roles: { none: { isActive: true } } },
        }),
        prisma.account.count({
          where: {
            teamId,
            archivedAt: null,
            isActive: true,
            memberships: { none: { isActive: true } },
          },
        }),
        prisma.season.findFirst({
          where: { teamId, isActive: true },
          select: { id: true, name: true, startDate: true, endDate: true },
        }),
      ]);

    return {
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
          tier: "platform" as const,
          platform: await platformSummary(account.id),
          member: null,
          lead: null,
          teamAdmin: null,
        };
      }

      const teamId = account.teamId;
      const matrix = await resolvePermissionMatrix(prisma, account.id);
      const tier = classify(account, matrix);

      const [member, lead, teamAdmin] = await Promise.all([
        memberSummary(teamId, account.id, matrix),
        tier === "lead" ? leadSummary(teamId, matrix) : Promise.resolve(null),
        tier === "team_admin" ? teamAdminSummary(teamId) : Promise.resolve(null),
      ]);

      return { scope: "team" as const, tier, platform: null, member, lead, teamAdmin };
    },
  };
}
