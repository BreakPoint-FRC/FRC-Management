import type {
  AttendanceStatus,
  CalendarEntryKind,
  SponsorshipStatus,
  TaskActivityAction,
  TaskPriority,
  TaskStatus,
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

/** One role an account holds, as the API flattens it. */
export interface AccountRoleRow {
  roleId: string;
  roleKey: string;
  roleName: string;
  scope: "GLOBAL" | "GROUP";
  hierarchyLevel: number;
  groupId: string | null;
  groupName: string | null;
}

export interface AccountRow {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  archivedAt: string | null;
  roles: AccountRoleRow[];
  groups: Array<{ id: string; name: string }>;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  memberCount: number;
  tools: Array<{ toolId: string; tool: string; isEnabled: boolean }>;
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  scope: "GLOBAL" | "GROUP";
  hierarchyLevel: number;
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
