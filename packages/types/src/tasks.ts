import { z } from "zod";

export const taskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "DONE"]);

export const taskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().nullable(),
  status: taskStatusSchema,
  groupId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
});

export type Task = z.infer<typeof taskSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
