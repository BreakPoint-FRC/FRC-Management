import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { NotFoundError } from "../../lib/http-errors";
import { listTasksQuerySchema, updateTaskSchema } from "./tasks.schema";
import { createTasksService } from "./tasks.service";

// Every service call is scoped to a team now. The id itself is arbitrary; what
// the tests pin is that it reaches the query.
const TEAM = "team-1";

describe("task payload validation", () => {
  it("rejects a due date before the start date", async () => {
    const result = updateTaskSchema.safeParse({
      startDate: "2026-09-20",
      dueDate: "2026-09-01",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["dueDate"]);
  });

  it("accepts a task that starts and ends on the same day", async () => {
    const result = updateTaskSchema.safeParse({
      startDate: "2026-09-20",
      dueDate: "2026-09-20",
    });

    expect(result.success).toBe(true);
  });

  it("reads a repeated status parameter as a list", async () => {
    const result = listTasksQuerySchema.parse({ status: ["TODO", "IN_PROGRESS"] });

    expect(result.status).toEqual(["TODO", "IN_PROGRESS"]);
  });
});

// A todo list is this table filtered, not a table of its own. These tests pin
// what "the todo list" means, because the alternative -- a second table -- is
// exactly what would let the two disagree about outstanding work.
describe("the todo view", () => {
  function stubPrisma(findMany: ReturnType<typeof vi.fn>) {
    return {
      task: { findMany, count: async () => 0 },
      $transaction: async (operations: unknown[]) => Promise.all(operations),
    } as unknown as PrismaClient;
  }

  it("open=true filters to the statuses that still need doing", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = createTasksService(stubPrisma(findMany));

    await service.list(TEAM, listTasksQuerySchema.parse({ open: "true" }));

    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      teamId: TEAM,
      status: { in: ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW"] },
    });
  });

  it("an explicit status filter wins over open", async () => {
    // Asking for COMPLETED and open work at once is a contradiction, and the
    // explicit filter is the one the caller actually typed.
    const findMany = vi.fn().mockResolvedValue([]);
    const service = createTasksService(stubPrisma(findMany));

    await service.list(TEAM, listTasksQuerySchema.parse({ open: "true", status: "COMPLETED" }));

    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      teamId: TEAM,
      status: { in: ["COMPLETED"] },
    });
  });

  it("lists everything when neither is given", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = createTasksService(stubPrisma(findMany));

    await service.list(TEAM, listTasksQuerySchema.parse({}));

    expect(findMany.mock.calls[0]?.[0].where).toEqual({ teamId: TEAM });
  });
});

// The history is written in the same transaction as the change it describes, so
// a task can never move without the log that explains it.
describe("activity logging", () => {
  const before = {
    status: "TODO",
    priority: "MEDIUM",
    startDate: null,
    dueDate: null,
    name: "Autonomous rutini",
  };

  function stubPrisma(createMany: ReturnType<typeof vi.fn>, updated: Record<string, unknown>) {
    const tx = {
      task: {
        update: async () => ({ assignees: [], group: null, ...before, ...updated }),
      },
      taskActivity: { createMany },
    };
    return {
      // findFirst, not findUnique: the team is half the identity now.
      task: { findFirst: async () => before },
      $transaction: async (fn: (client: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;
  }

  it("writes one entry per field that actually moved", async () => {
    const createMany = vi.fn();
    const service = createTasksService(stubPrisma(createMany, { priority: "CRITICAL" }));

    await service.update(TEAM, "task-1", { priority: "CRITICAL" }, "account-1");

    const entries = createMany.mock.calls[0]?.[0].data;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "PRIORITY_CHANGED",
      oldValue: { priority: "MEDIUM" },
      newValue: { priority: "CRITICAL" },
    });
  });

  it("writes nothing when a PATCH resends the value already stored", async () => {
    const createMany = vi.fn();
    const service = createTasksService(stubPrisma(createMany, { status: "TODO" }));

    await service.update(TEAM, "task-1", { status: "TODO" }, "account-1");

    expect(createMany).not.toHaveBeenCalled();
  });

  it("records reaching a terminal state as COMPLETED, not another status change", async () => {
    const createMany = vi.fn();
    const service = createTasksService(stubPrisma(createMany, { status: "COMPLETED" }));

    await service.update(TEAM, "task-1", { status: "COMPLETED" }, "account-1");

    expect(createMany.mock.calls[0]?.[0].data[0]).toMatchObject({ action: "COMPLETED" });
  });

  it("collapses untracked fields into a single UPDATED entry", async () => {
    const createMany = vi.fn();
    const service = createTasksService(
      stubPrisma(createMany, { name: "Yeni ad", description: "yeni" })
    );

    await service.update(TEAM, "task-1", { name: "Yeni ad", description: "yeni" }, "account-1");

    const entries = createMany.mock.calls[0]?.[0].data;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "UPDATED",
      newValue: { name: "Yeni ad", description: "yeni" },
    });
  });
});

describe("assignees", () => {
  it("rejects a cross-team assignee before resolving a season or starting a write", async () => {
    const seasonLookup = vi.fn();
    const transaction = vi.fn();
    const prisma = {
      account: { count: async () => 1 },
      season: { findFirst: seasonLookup },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      createTasksService(prisma).create(
        TEAM,
        {
          name: "Tenant boundary",
          status: "TODO",
          priority: "MEDIUM",
          assigneeIds: ["local-account", "other-team-account"],
        },
        "actor-1"
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(seasonLookup).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("logs who was added and who was removed, not just that it changed", async () => {
    const createMany = vi.fn();
    const deleteMany = vi.fn();
    const assigneeCreateMany = vi.fn();

    const tx = {
      taskAssignee: { deleteMany, createMany: assigneeCreateMany },
      taskActivity: { createMany },
      task: { findUniqueOrThrow: async () => ({ assignees: [], group: null }) },
    };
    const prisma = {
      // The service proves the task and every assignee belong to the team
      // before it writes anything, so the stub has to answer both counts.
      task: { count: async () => 1 },
      account: { count: async () => 2 },
      taskAssignee: { findMany: async () => [{ accountId: "emre" }, { accountId: "kerem" }] },
      $transaction: async (fn: (client: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;

    await createTasksService(prisma).replaceAssignees(
      TEAM,
      "task-1",
      { accountIds: ["kerem", "deniz"] },
      "account-1"
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { taskId: "task-1", accountId: { in: ["emre"] } },
    });
    expect(assigneeCreateMany).toHaveBeenCalledWith({
      data: [{ taskId: "task-1", accountId: "deniz" }],
    });
    expect(createMany.mock.calls[0]?.[0].data).toEqual([
      { taskId: "task-1", actorId: "account-1", action: "ASSIGNEE_ADDED", newValue: { accountId: "deniz" } },
      { taskId: "task-1", actorId: "account-1", action: "ASSIGNEE_REMOVED", oldValue: { accountId: "emre" } },
    ]);
  });
});
