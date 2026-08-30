import type { Prisma, PrismaClient, TaskActivityAction } from "@breakpoint/db";
import { OPEN_TASK_STATUSES, type PaginationInput } from "@breakpoint/types";

import { resolveSeasonId } from "../../lib/active-season";
import { NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type {
  CreateTaskInput,
  ListTasksQuery,
  ReplaceAssigneesInput,
  UpdateTaskInput,
} from "./tasks.schema";

const taskSelect = {
  id: true,
  seasonId: true,
  groupId: true,
  name: true,
  description: true,
  startDate: true,
  dueDate: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  group: { select: { name: true } },
  createdBy: { select: { id: true, fullName: true } },
  assignees: {
    select: { assignedAt: true, account: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

function serialize(task: TaskRow) {
  const { assignees, group, ...rest } = task;
  return {
    ...rest,
    groupName: group?.name ?? null,
    assignees: assignees.map((entry) => ({
      accountId: entry.account.id,
      fullName: entry.account.fullName,
      assignedAt: entry.assignedAt,
    })),
  };
}

/**
 * Narrows a field value to something a JSON column can hold.
 *
 * The log stores what a field was and became, not the value itself, so a
 * string is the right shape for all of them -- and it keeps a Date out of a
 * JSON column, where it would serialise differently depending on who wrote it.
 */
function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The fields a change to which is worth its own line in the history. */
const TRACKED: Array<{
  field: keyof UpdateTaskInput;
  action: TaskActivityAction;
}> = [
  { field: "status", action: "STATUS_CHANGED" },
  { field: "priority", action: "PRIORITY_CHANGED" },
  { field: "startDate", action: "START_DATE_CHANGED" },
  { field: "dueDate", action: "DUE_DATE_CHANGED" },
];

export function createTasksService(prisma: PrismaClient) {
  return {
    list: async (query: ListTasksQuery) => {
      const where: Prisma.TaskWhereInput = {
        ...(query.seasonId ? { seasonId: query.seasonId } : {}),
        ...(query.groupId ? { groupId: query.groupId } : {}),
        ...(query.priority ? { priority: { in: query.priority } } : {}),
        ...(query.assigneeId ? { assignees: { some: { accountId: query.assigneeId } } } : {}),
        // An explicit status filter wins over `open`: asking for COMPLETED and
        // open work at once is a contradiction, and the explicit one is what
        // the caller actually typed.
        ...(query.status
          ? { status: { in: query.status } }
          : query.open
            ? { status: { in: [...OPEN_TASK_STATUSES] } }
            : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.task.findMany({
          where,
          select: taskSelect,
          // Nulls last, so undated work does not sit above what is due tomorrow.
          orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
          ...toPrismaPage(query),
        }),
        prisma.task.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    getById: async (id: string) => {
      const task = await prisma.task.findUnique({ where: { id }, select: taskSelect });
      return task && serialize(task);
    },

    /** Only used to decide which group to authorize a mutation against. */
    groupOf: (id: string) =>
      prisma.task.findUnique({ where: { id }, select: { id: true, groupId: true } }),

    activity: async (taskId: string, page: PaginationInput) => {
      const [rows, total] = await prisma.$transaction([
        prisma.taskActivity.findMany({
          where: { taskId },
          select: {
            id: true,
            action: true,
            oldValue: true,
            newValue: true,
            createdAt: true,
            actor: { select: { id: true, fullName: true } },
          },
          orderBy: { createdAt: "desc" },
          ...toPrismaPage(page),
        }),
        prisma.taskActivity.count({ where: { taskId } }),
      ]);

      return paginated(rows, total, page);
    },

    create: async (input: CreateTaskInput, actorId: string) => {
      const { assigneeIds, seasonId, ...rest } = input;
      const resolvedSeasonId = await resolveSeasonId(prisma, seasonId);

      // Task, assignees and the log line in one transaction. A task that exists
      // with no record of having been created is a hole in the audit trail, and
      // the point of the trail is that it has none.
      const task = await prisma.$transaction(async (tx) => {
        const created = await tx.task.create({
          data: { ...rest, seasonId: resolvedSeasonId, createdById: actorId },
          select: { id: true },
        });

        if (assigneeIds.length > 0) {
          await tx.taskAssignee.createMany({
            data: assigneeIds.map((accountId) => ({ taskId: created.id, accountId })),
          });
        }

        await tx.taskActivity.create({
          data: {
            taskId: created.id,
            actorId,
            action: "CREATED",
            newValue: { name: rest.name, status: rest.status, priority: rest.priority },
          },
        });

        return tx.task.findUniqueOrThrow({ where: { id: created.id }, select: taskSelect });
      });

      return serialize(task);
    },

    update: async (id: string, input: UpdateTaskInput, actorId: string) => {
      const before = await prisma.task.findUnique({
        where: { id },
        select: { status: true, priority: true, startDate: true, dueDate: true, name: true },
      });
      if (!before) throw new NotFoundError("Gorev bulunamadi");

      const task = await prisma.$transaction(async (tx) => {
        const updated = await tx.task.update({
          where: { id },
          data: input,
          select: taskSelect,
        });

        // One entry per field that actually moved. Comparing before and after
        // rather than trusting the payload means a PATCH that resends the same
        // status does not add a line saying it changed.
        const entries: Prisma.TaskActivityCreateManyInput[] = [];

        for (const { field, action } of TRACKED) {
          if (!(field in input)) continue;

          const from = before[field as keyof typeof before] ?? null;
          const to = (updated[field as keyof typeof updated] ?? null) as unknown;
          if (String(from) === String(to)) continue;

          entries.push({
            taskId: id,
            actorId,
            // Reaching a terminal state is worth saying plainly rather than as
            // another status change.
            action:
              field === "status" && (to === "COMPLETED" || to === "CANCELLED")
                ? (to as TaskActivityAction)
                : action,
            oldValue: { [field]: toJson(from) },
            newValue: { [field]: toJson(to) },
          });
        }

        // Anything else that changed collapses into one line: the history is
        // for answering "who moved this and when", not for diffing prose.
        const untracked = Object.keys(input).filter(
          (key) => !TRACKED.some((tracked) => tracked.field === key)
        );
        if (untracked.length > 0) {
          entries.push({
            taskId: id,
            actorId,
            action: "UPDATED",
            newValue: Object.fromEntries(
              untracked.map((key) => [key, toJson((input as Record<string, unknown>)[key])])
            ),
          });
        }

        if (entries.length > 0) await tx.taskActivity.createMany({ data: entries });

        return updated;
      });

      return serialize(task);
    },

    /**
     * Replaces the assignee set and logs the difference.
     *
     * Whole-set like every other assignment here, but the log records who was
     * added and who was removed rather than "assignees changed" -- that is the
     * question anyone reads this history to answer.
     */
    replaceAssignees: async (id: string, input: ReplaceAssigneesInput, actorId: string) => {
      const existing = await prisma.taskAssignee.findMany({
        where: { taskId: id },
        select: { accountId: true },
      });

      const before = new Set(existing.map((entry) => entry.accountId));
      const after = new Set(input.accountIds);
      const added = input.accountIds.filter((accountId) => !before.has(accountId));
      const removed = [...before].filter((accountId) => !after.has(accountId));

      const task = await prisma.$transaction(async (tx) => {
        if (removed.length > 0) {
          await tx.taskAssignee.deleteMany({ where: { taskId: id, accountId: { in: removed } } });
        }
        if (added.length > 0) {
          await tx.taskAssignee.createMany({
            data: added.map((accountId) => ({ taskId: id, accountId })),
          });
        }

        const entries: Prisma.TaskActivityCreateManyInput[] = [
          ...added.map((accountId) => ({
            taskId: id,
            actorId,
            action: "ASSIGNEE_ADDED" as const,
            newValue: { accountId },
          })),
          ...removed.map((accountId) => ({
            taskId: id,
            actorId,
            action: "ASSIGNEE_REMOVED" as const,
            oldValue: { accountId },
          })),
        ];
        if (entries.length > 0) await tx.taskActivity.createMany({ data: entries });

        return tx.task.findUniqueOrThrow({ where: { id }, select: taskSelect });
      });

      return serialize(task);
    },

    /**
     * Hard delete. Assignees, activity and any Gantt placement cascade with it.
     *
     * The log describes this task, so it has nothing to say once the task is
     * gone -- unlike a meeting or a transaction, which are records of something
     * that happened in the world. Cancelling is the soft option and is a status.
     */
    remove: (id: string) => prisma.task.delete({ where: { id } }),
  };
}
