import { z } from "zod";

// A named timeline over existing tasks. It carries ordering and nothing else --
// no dates, no status, no group. Those live on Task and are read through the
// join, so a board can never drift from the work it draws.
export const ganttBoardSchema = z.object({
  id: z.string(),
  seasonId: z.string(),
  groupId: z.string().nullable(),
  name: z.string().min(1),
});

export const ganttTaskSchema = z.object({
  taskId: z.string().min(1),
  displayOrder: z.number().int().min(0),
});

export type GanttBoard = z.infer<typeof ganttBoardSchema>;
export type GanttTask = z.infer<typeof ganttTaskSchema>;
