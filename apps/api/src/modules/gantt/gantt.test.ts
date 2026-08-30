import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import {
  listBoardsQuerySchema,
  replaceBoardTasksSchema,
  updateBoardSchema,
} from "./gantt.schema";
import { createGanttService } from "./gantt.service";

describe("board payload validation", () => {
  it("rejects the same task twice, pointing at the entry", () => {
    const result = replaceBoardTasksSchema.safeParse({ taskIds: ["t1", "t2", "t1"] });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["taskIds", 2]);
  });

  it("accepts an empty board", () => {
    // Clearing a board is how you take everything off it.
    expect(replaceBoardTasksSchema.safeParse({ taskIds: [] }).success).toBe(true);
  });

  it("has nowhere to put a date", () => {
    // A board stores ordering and nothing else. If a date could be written here
    // it would drift from the task the moment either changed.
    const result = replaceBoardTasksSchema.safeParse({
      taskIds: ["t1"],
      startDate: "2026-01-01",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("startDate");
  });

  it("distinguishes an omitted group from an explicit null", () => {
    // This is the whole difference between renaming a board and moving it to
    // the whole team, and the routes rely on it: only `groupId !== undefined`
    // triggers a second authorization check against the destination.
    expect(updateBoardSchema.parse({ name: "Yeni ad" }).groupId).toBeUndefined();
    expect(updateBoardSchema.parse({ name: "Yeni ad", groupId: null }).groupId).toBeNull();
  });
});

describe("listing boards", () => {
  function stubPrisma(rows: unknown[] = []) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      ganttBoard: { findMany, count: async () => rows.length },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;

    return { prisma, findMany };
  }

  it("filters to one department when asked", async () => {
    const { prisma, findMany } = stubPrisma();

    await createGanttService(prisma).list(listBoardsQuerySchema.parse({ groupId: "g1" }));

    expect(findMany.mock.calls[0]?.[0].where).toEqual({ groupId: "g1" });
  });

  it("does not filter at all when no group is given", async () => {
    // An unfiltered list is a team-wide read. The route is what refuses it for
    // an account without a global role; the service just does not narrow.
    const { prisma, findMany } = stubPrisma();

    await createGanttService(prisma).list(listBoardsQuerySchema.parse({}));

    expect(findMany.mock.calls[0]?.[0].where).toEqual({});
  });

  it("reads every date off the task, not off the board", async () => {
    const { prisma } = stubPrisma([
      {
        id: "b1",
        seasonId: "s1",
        groupId: "g1",
        name: "Yazilim yol haritasi",
        createdAt: new Date(2026, 0, 1),
        group: { name: "Programlama" },
        season: { name: "2026" },
        tasks: [
          {
            displayOrder: 0,
            task: {
              id: "t1",
              name: "Otonom",
              status: "IN_PROGRESS",
              priority: "HIGH",
              startDate: new Date(2026, 0, 10),
              dueDate: new Date(2026, 1, 1),
              groupId: "g1",
              assignees: [{ account: { id: "a1", fullName: "Ada Yilmaz" } }],
            },
          },
        ],
      },
    ]);

    const { items } = await createGanttService(prisma).list(listBoardsQuerySchema.parse({}));

    expect(items[0]).toMatchObject({ groupId: "g1", groupName: "Programlama", seasonName: "2026" });
    expect(items[0]?.tasks[0]).toMatchObject({
      id: "t1",
      displayOrder: 0,
      startDate: new Date(2026, 0, 10),
      dueDate: new Date(2026, 1, 1),
      assignees: [{ id: "a1", fullName: "Ada Yilmaz" }],
    });
  });
});

describe("updating a board", () => {
  function stubPrisma() {
    const update = vi.fn().mockResolvedValue({
      id: "b1",
      seasonId: "s1",
      groupId: "g1",
      name: "Yeni ad",
      createdAt: new Date(2026, 0, 1),
      group: { name: "Programlama" },
      season: { name: "2026" },
      tasks: [],
    });

    return { prisma: { ganttBoard: { update } } as unknown as PrismaClient, update };
  }

  it("does not touch the group when only the name was sent", async () => {
    // The regression this guards: the web form used to send groupId:"" on every
    // save, which the client turned into null, so renaming a department's board
    // silently moved it to the whole team.
    const { prisma, update } = stubPrisma();

    await createGanttService(prisma).update("b1", updateBoardSchema.parse({ name: "Yeni ad" }));

    expect(update.mock.calls[0]?.[0].data).toEqual({ name: "Yeni ad" });
    expect(update.mock.calls[0]?.[0].data).not.toHaveProperty("groupId");
  });

  it("still moves a board to the team when null is meant", async () => {
    const { prisma, update } = stubPrisma();

    await createGanttService(prisma).update("b1", updateBoardSchema.parse({ groupId: null }));

    expect(update.mock.calls[0]?.[0].data).toEqual({ groupId: null });
  });
});

describe("replacing the task list", () => {
  function stubPrisma(validTaskCount: number) {
    const deleteMany = vi.fn();
    const createMany = vi.fn();

    const prisma = {
      ganttBoard: {
        findUniqueOrThrow: async () => ({ seasonId: "s1" }),
      },
      task: { count: async () => validTaskCount },
      $transaction: async (fn: (client: unknown) => unknown) =>
        fn({
          ganttTask: { deleteMany, createMany },
          ganttBoard: {
            findUniqueOrThrow: async () => ({
              id: "b1",
              seasonId: "s1",
              groupId: null,
              name: "Sezon plani",
              createdAt: new Date(2026, 0, 1),
              group: null,
              season: { name: "2026" },
              tasks: [],
            }),
          },
        }),
    } as unknown as PrismaClient;

    return { prisma, deleteMany, createMany };
  }

  it("numbers displayOrder from the array index", async () => {
    // The client sends an order, not numbers: letting it pick them invites
    // gaps, ties and an off-by-one nobody can see.
    const { prisma, createMany } = stubPrisma(3);

    await createGanttService(prisma).replaceTasks("b1", { taskIds: ["t3", "t1", "t2"] });

    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      { ganttBoardId: "b1", taskId: "t3", displayOrder: 0 },
      { ganttBoardId: "b1", taskId: "t1", displayOrder: 1 },
      { ganttBoardId: "b1", taskId: "t2", displayOrder: 2 },
    ]);
  });

  it("refuses tasks from another season", async () => {
    // Quietly drawing last year's work onto this year's plan would make the
    // timeline wrong in a way that looks fine.
    const { prisma } = stubPrisma(1);

    await expect(
      createGanttService(prisma).replaceTasks("b1", { taskIds: ["t1", "t2"] })
    ).rejects.toThrow("Gorevlerin hepsi bu sezona ait degil");
  });

  it("clears the board without writing an empty createMany", async () => {
    const { prisma, deleteMany, createMany } = stubPrisma(0);

    await createGanttService(prisma).replaceTasks("b1", { taskIds: [] });

    expect(deleteMany).toHaveBeenCalledWith({ where: { ganttBoardId: "b1" } });
    expect(createMany).not.toHaveBeenCalled();
  });
});
