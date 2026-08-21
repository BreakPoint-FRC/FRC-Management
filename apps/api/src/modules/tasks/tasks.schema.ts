import { z } from "zod";
import { taskStatusSchema } from "@breakpoint/types";

export const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  groupId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  status: taskStatusSchema.optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
