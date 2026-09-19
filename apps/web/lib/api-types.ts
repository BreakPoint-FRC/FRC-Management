import type {
  AuditAction,
  AuditEntityType,
  AttendanceStatus,
  CalendarEntryKind,
  RolePlacement,
  SponsorshipStatus,
  TaskActivityAction,
  TaskPriority,
  TaskStatus,
  TeamSetupStage,
  TransactionType,
} from "@breakpoint/types";

/**
 * The shapes the API actually sends, as JSON.
 *
 * These are not the schemas in @breakpoint/types and are not a duplicate of
 * them. Those describe a *parsed* record -- `taskSchema` coerces dates, so
 * `Task["dueDate"]` is a `Date`. What arrives over the wire is a string, and a
 * list row also carries fields the entity has no notion of: `groupName`, the
 * flattened `createdBy`, an `assignees` array joined in by the service.
 *
 * Enums and labels still come from the shared package -- only the envelope is
 * described here.
 */

/**
 * One role an account holds, as the API flattens it.
 *
 * `depth` is where the role sits in the RoleHierarchy graph, computed by the
 * API on every read. It replaced a stored hierarchyLevel column: a derived
 * number cannot disagree with the graph it came from.
 */
export interface AccountRoleRow {
  roleId: string;
  roleKey: string;
  roleName: string;
  placement: RolePlacement;
  depth: number;
  groupId: string | null;
  groupName: string | null;
}

/** One row of a bulk-import CSV, as /accounts/bulk-import/preview and
 *  /commit both report it -- commit sends the identical shape when it
 *  refuses to write, so one type covers both. */
export interface BulkImportRowResult {
  line: number;
  fullName: string;
  email: string;
  status: "ok" | "invalid" | "duplicate_in_file" | "duplicate_in_db";
  issues: string[];
}

export interface BulkImportPreviewResult {
  fileError: string | null;
  rows: BulkImportRowResult[];
  valid: boolean;
}

/** POST /accounts/bulk-import/commit. Discriminated on `committed`: the
 *  false case is the same shape a preview sends, because refusing to write
 *  a batch that no longer validates is an ordinary answer, not an error. */
export type BulkImportCommitResult =
  | ({ committed: true; batchId: string } & {
      created: Array<{ id: string; email: string; fullName: string; temporaryPassword: string }>;
    })
  | ({ committed: false } & BulkImportPreviewResult);

export interface AccountRow {
  id: string;
  teamId: string | null;
  email: string;
  fullName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  archivedAt: string | null;
  roles: AccountRoleRow[];
  groups: Array<{ id: string; name: string }>;
}

/** A team, as /teams and /setup send it. */
export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  setupStage: TeamSetupStage;
  setupCompletedAt: string | null;
  createdAt: string;
  accountCount: number;
  groupCount: number;
}

/**
 * A department.
 *
 * `tools` is what this group states for itself; `effectiveTools` is what
 * actually applies once inheritance from its ancestors is resolved. The screen
 * needs both -- a row can look locally configured when it is really borrowing
 * the answer from three levels up.
 */
export interface GroupRow {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  memberCount: number;
  tools: Array<{ toolId: string; tool: string; isEnabled: boolean }>;
  effectiveTools: Array<{ tool: string; isEnabled: boolean; inheritedFrom: string | null }>;
}

/** The tree endpoint, which sends the shape without the tool detail. */
export interface GroupTreeRow {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface RoleRow {
  id: string;
  teamId: string | null;
  key: string;
  name: string;
  description: string | null;
  placement: RolePlacement;
  /** Derived from the hierarchy graph on read, never stored. */
  depth: number;
  /** The roots of the authority of this role; subgroups are covered too. */
  groupScopeIds: string[];
  groupScopes: Array<{ id: string; name: string }>;
  isSystemRole: boolean;
  assignedCount: number;
  permissions: Array<{
    toolId: string;
    tool: string;
    canRead: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
  }>;
  children: Array<{ id: string; key: string; name: string }>;
  parents: Array<{ id: string; key: string; name: string }>;
}

/**
 * The hierarchy as the roles screen draws it.
 *
 * `closure` is the transitive part: if a role is above a second and that one is
 * above a third, the first is above the third as well. Nothing stores it -- the
 * API walks the edges, which is what keeps the relation from needing a rank
 * number to maintain.
 */
export interface RoleGraphRow {
  roles: Array<{ id: string; key: string; name: string; placement: RolePlacement; depth: number }>;
  edges: Array<{ parentRoleId: string; childRoleId: string }>;
  closure: Array<{ roleId: string; below: string[] }>;
}

/** A security audit row as GET /audit-log sends it over JSON. */
export interface AuditLogRow {
  id: string;
  teamId: string;
  actorId: string;
  actor: { id: string; fullName: string };
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  oldValue: unknown | null;
  newValue: unknown | null;
  createdAt: string;
}

/** GET /setup -- where the team is in its first-run flow. */
export interface SetupStateRow {
  team: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    setupStage: TeamSetupStage;
    setupCompletedAt: string | null;
  };
  stage: TeamSetupStage;
  stages: TeamSetupStage[];
  progress: {
    groups: number;
    roles: number;
    groupTools: number;
    permissions: number;
    accounts: number;
    seasons: number;
  };
  /** Why the current step cannot be left yet, or null when it can. */
  blocker: string | null;
}

export interface ToolRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface SeasonRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  _count: {
    tasks: number;
    meetings: number;
    transactions: number;
    sponsorships: number;
    ganttBoards: number;
  };
}

export interface TaskRow {
  id: string;
  name: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  groupId: string | null;
  groupName: string | null;
  startDate: string | null;
  dueDate: string | null;
  createdBy: { id: string; fullName: string };
  assignees: Array<{ accountId: string; fullName: string }>;
}

export interface TaskActivityRow {
  id: string;
  action: TaskActivityAction;
  oldValue: Record<string, string | null> | null;
  newValue: Record<string, string | null> | null;
  createdAt: string;
  actor: { id: string; fullName: string } | null;
}

export interface MeetingRow {
  id: string;
  title: string;
  body: string | null;
  meetingDate: string;
  groupId: string | null;
  groupName: string | null;
  createdBy: { id: string; fullName: string };
  attendance: Array<{
    accountId: string;
    fullName: string;
    status: AttendanceStatus;
    note: string | null;
  }>;
  attendedCount: number;
}

export interface TransactionRow {
  id: string;
  type: TransactionType;
  category: string;
  /** A decimal string, never a number -- see lib/format.ts. */
  amount: string;
  description: string | null;
  transactionDate: string;
  groupId: string | null;
  groupName: string | null;
  createdBy: { id: string; fullName: string };
  sponsorshipId: string | null;
  /** Set only when this row came from "Finansa işle" on a sponsorship. */
  source: { sponsorshipId: string; organizationId: string; organizationName: string } | null;
}

export interface FinanceSummaryRow {
  income: string;
  expense: string;
  net: string;
}

/**
 * Set once a sponsorship has been booked as income via "Finansa işle".
 *
 * amount and transactionDate are null when the viewer has SPONSORS/read but
 * not team-wide FINANCE/read -- the conversion is visible, the money is not.
 */
export interface SponsorshipFinanceLink {
  id: string;
  amount: string | null;
  transactionDate: string | null;
}

export interface OrganizationRow {
  id: string;
  name: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  sponsorships: Array<{
    id: string;
    status: SponsorshipStatus;
    amount: string | null;
    season: { id: string; name: string };
    financeTransaction: SponsorshipFinanceLink | null;
  }>;
}

export interface GanttBoardTask {
  id: string;
  name: string;
  status: TaskStatus;
  startDate: string | null;
  dueDate: string | null;
  displayOrder: number;
}

export interface GanttBoardRow {
  id: string;
  name: string;
  seasonId: string;
  seasonName: string;
  /**
   * The department, or null for a team-wide board.
   *
   * The API has always sent this; it was simply never written down here, which
   * is why the edit form had nothing but groupName to work from and reset the
   * board's group every time it saved.
   */
  groupId: string | null;
  groupName: string | null;
  tasks: GanttBoardTask[];
}

/** One month of the ledger, summed by the API. Every figure is a decimal
    string, for the reason given on TransactionRow.amount. */
export interface FinanceMonthlyRow {
  /** "2026-01". Parsed by monthLabel in lib/format.ts, never by new Date(). */
  month: string;
  income: string;
  expense: string;
  net: string;
}

export interface CalendarEntryRow {
  kind: CalendarEntryKind;
  /** The meeting or task id -- what the cell links to. */
  id: string;
  title: string;
  date: string;
  groupId: string | null;
  groupName: string | null;
  /** Only tasks carry one; meetings send null. */
  status: TaskStatus | null;
}

export interface CalendarRangeRow {
  items: CalendarEntryRow[];
  /**
   * The season the window falls in, so the page can dim the days outside it.
   * A season is a range rather than a day, which is why it is not an entry.
   */
  season: { id: string; name: string; startDate: string; endDate: string } | null;
}

interface DashboardTaskRow {
  id: string;
  name: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  groupName: string | null;
}

interface DashboardMeetingRow {
  id: string;
  title: string;
  meetingDate: string;
  groupName: string | null;
}

/**
 * GET /dashboard. Scope tabs, not a role mode: `mine`/`group`/`team`/
 * `management` are independent and can all be present at once for one
 * account, exactly like the OR-merged permission model they are computed
 * from -- a software captain who is also the team captain and a finance
 * reader gets all three non-`mine` blocks together. Each is non-null only
 * when the account's resolved grants actually qualify for it (see
 * dashboard.service.ts's computeScopes); a plain member gets `mine` alone.
 * `platform` is the one exclusive case: a platform account gets it and
 * nothing else, because it belongs to no team.
 */
export interface DashboardRow {
  scope: "platform" | "team";
  platform: {
    activeTeamCount: number;
    archivedTeamCount: number;
    recentTeams: Array<{ id: string; name: string; createdAt: string; setupStage: TeamSetupStage }>;
  } | null;
  mine: {
    openTasks: DashboardTaskRow[];
    overdueTasks: DashboardTaskRow[];
    upcomingMeetings: DashboardMeetingRow[];
    groups: Array<{ id: string; name: string }>;
    roles: Array<{ roleName: string; groupName: string | null }>;
  } | null;
  group: Array<{
    groupId: string;
    groupName: string;
    openCount: number;
    overdueCount: number;
    unassignedCount: number;
    completedThisWeekCount: number;
    topTasks: DashboardTaskRow[];
    upcomingMeeting: DashboardMeetingRow | null;
  }> | null;
  team: {
    departments: Array<{
      groupId: string;
      groupName: string;
      openCount: number;
      overdueCount: number;
      unassignedCount: number;
    }>;
    activeSeason: { id: string; name: string; endDate: string } | null;
    seasonDaysRemaining: number | null;
    upcomingMeeting: DashboardMeetingRow | null;
    crossGroupOpenTaskCount: number;
    crossGroupUnassignedTaskCount: number;
  } | null;
  management: {
    activeAccountCount: number;
    mustChangePasswordCount: number;
    withoutRoleCount: number;
    withoutGroupCount: number;
    activeSeason: { id: string; name: string; startDate: string; endDate: string } | null;
    setupIncomplete: boolean;
  } | null;
}
