import type { Prisma, PrismaClient } from "@breakpoint/db";

import { resolveSeasonId } from "../../lib/active-season";
import { ConflictError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type {
  CreateBoardInput,
  ListBoardsQuery,
  ReplaceBoardTasksInput,
  UpdateBoardInput,
} from "./gantt.schema";

// The timeline is read straight off Task. GanttTask contributes displayOrder
// and nothing else, which is the whole point: a board cannot show a date the
// task does not have, because it has no date of its own to disagree with.
const boardSelect = {
  id: true,
  seasonId: true,
  groupId: true,
  name: true,
  createdAt: true,
  group: { select: { name: true } },
  season: { select: { name: true } },
  tasks: {
    select: {
      displayOrder: true,
      task: {
        select: {
          id: true,
          name: true,
          status: true,
          priority: true,
          startDate: true,
          dueDate: true,
          groupId: true,
          assignees: { select: { account: { select: { id: true, fullName: true } } } },
        },
      },
    },
    orderBy: { displayOrder: "asc" },
  },
} satisfies Prisma.GanttBoardSelect;

type BoardRow = Prisma.GanttBoardGetPayload<{ select: typeof boardSelect }>;

function serialize(board: BoardRow) {
  const { tasks, group, season, ...rest } = board;
  return {
    ...rest,
    groupName: group?.name ?? null,
    seasonName: season.name,
    tasks: tasks.map((entry) => ({
      displayOrder: entry.displayOrder,
      ...entry.task,
      assignees: entry.task.assignees.map((assignee) => assignee.account),
    })),
  };
}

export function createGanttService(prisma: PrismaClient) {
  return {
    list: async (query: ListBoardsQuery) => {
      const where: Prisma.GanttBoardWhereInput = {
        ...(query.seasonId ? { seasonId: query.seasonId } : {}),
        ...(query.groupId ? { groupId: query.groupId } : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.ganttBoard.findMany({
          where,
          select: boardSelect,
          orderBy: { name: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.ganttBoard.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    getById: async (id: string) => {
      const board = await prisma.ganttBoard.findUnique({ where: { id }, select: boardSelect });
      return board && serialize(board);
    },

    groupOf: (id: string) =>
      prisma.ganttBoard.findUnique({ where: { id }, select: { id: true, groupId: true } }),

    create: async ({ seasonId, ...rest }: CreateBoardInput) => {
      const resolvedSeasonId = await resolveSeasonId(prisma, seasonId);
      const board = await prisma.ganttBoard.create({
        data: { ...rest, seasonId: resolvedSeasonId },
        select: boardSelect,
      });
      return serialize(board);
    },

    update: async (id: string, input: UpdateBoardInput) => {
      const board = await prisma.ganttBoard.update({
        where: { id },
        data: input,
        select: boardSelect,
      });
      return serialize(board);
    },

    /**
     * Replaces the board's task list, in the order given.
     *
     * displayOrder is the array index rather than a number the client sends:
     * reordering by drag is a new array, and letting the client pick the
     * numbers invites gaps, ties and an off-by-one nobody can see.
     *
     * Tasks from a different season are refused. A board is a season's plan,
     * and quietly drawing last year's work onto it would make the timeline
     * wrong in a way that looks fine.
     */
    replaceTasks: async (boardId: string, input: ReplaceBoardTasksInput) => {
      const board = await prisma.ganttBoard.findUniqueOrThrow({
        where: { id: boardId },
        select: { seasonId: true },
      });

      if (input.taskIds.length > 0) {
        const valid = await prisma.task.count({
          where: { id: { in: input.taskIds }, seasonId: board.seasonId },
        });
        if (valid !== input.taskIds.length) {
          throw new ConflictError("Gorevlerin hepsi bu sezona ait degil");
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.ganttTask.deleteMany({ where: { ganttBoardId: boardId } });
        if (input.taskIds.length > 0) {
          await tx.ganttTask.createMany({
            data: input.taskIds.map((taskId, index) => ({
              ganttBoardId: boardId,
              taskId,
              displayOrder: index,
            })),
          });
        }
        return tx.ganttBoard.findUniqueOrThrow({ where: { id: boardId }, select: boardSelect });
      });

      return serialize(updated);
    },

    /** Deletes the board and its ordering. The tasks themselves are untouched. */
    remove: (id: string) => prisma.ganttBoard.delete({ where: { id } }),
  };
}
