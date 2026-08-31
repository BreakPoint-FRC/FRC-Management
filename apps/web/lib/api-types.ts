import type {
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
  _count: { tasks: number; meetings: number; transactions: number; sponsorships: number };
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
}

export interface FinanceSummaryRow {
  income: string;
  expense: string;
  net: string;
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
