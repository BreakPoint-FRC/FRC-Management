import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import { createTaskSchema } from "./tasks.schema";
import { createTasksService } from "./tasks.service";

describe("tasks.schema", () => {
  it("accepts a task without a group (cross-group task)", () => {
    const result = createTaskSchema.safeParse({ title: "Order motors" });
    expect(result.success).toBe(true);
  });

  it("accepts a task scoped to a group", () => {
    const result = createTaskSchema.safeParse({
      title: "Wire the drivetrain",
      groupId: "g1",
    });
    expect(result.success).toBe(true);
  });

  it("lists all tasks when no group filter is provided", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { task: { findMany } } as unknown as PrismaClient;

    await createTasksService(prisma).list();

    expect(findMany).toHaveBeenCalledWith({ where: undefined });
  });

  it("filters tasks when a group id is provided", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { task: { findMany } } as unknown as PrismaClient;

    await createTasksService(prisma).list("group-1");

    expect(findMany).toHaveBeenCalledWith({ where: { groupId: "group-1" } });
  });
});
