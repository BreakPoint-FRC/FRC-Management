import type { PrismaClient } from "@breakpoint/db";
import type { CreateTaskInput, UpdateTaskInput } from "./tasks.schema";

export function createTasksService(prisma: PrismaClient) {
  return {
    // Omit groupId to list all tasks; pass it to scope the list to one group.
    list: (groupId?: string) =>
      prisma.task.findMany({ where: groupId ? { groupId } : undefined }),

    getById: (id: string) => prisma.task.findUnique({ where: { id } }),

    create: (input: CreateTaskInput) => prisma.task.create({ data: input }),

    update: (id: string, input: UpdateTaskInput) =>
      prisma.task.update({ where: { id }, data: input }),

    remove: (id: string) => prisma.task.delete({ where: { id } }),
  };
}
