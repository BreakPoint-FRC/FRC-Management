import { z } from "zod";

export const taskStatusSchema = z.enum([
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "BLOCKED",
  "IN_REVIEW",
  "COMPLETED",
  "CANCELLED",
]);

export const taskPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const taskActivityActionSchema = z.enum([
  "CREATED",
  "UPDATED",
  "STATUS_CHANGED",
  "PRIORITY_CHANGED",
  "ASSIGNEE_ADDED",
  "ASSIGNEE_REMOVED",
  "START_DATE_CHANGED",
  "DUE_DATE_CHANGED",
  "COMPLETED",
  "CANCELLED",
]);

export const taskSchema = z.object({
  id: z.string(),
  seasonId: z.string(),
  // Null means a cross-group task, which the roadmap has in V1. A task with no
  // group is authorized on the GLOBAL path.
  groupId: z.string().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
});

export const taskAssigneeSchema = z.object({
  accountId: z.string(),
  assignedAt: z.coerce.date(),
});

export const taskActivitySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  actorId: z.string().nullable(),
  action: taskActivityActionSchema,
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  createdAt: z.coerce.date(),
});

// Enum values are English to match the rest of the codebase; everything the
// team actually reads is Turkish. Complete records rather than partial maps, so
// adding a status fails typecheck until it has a label.
export const taskStatusLabels: Record<TaskStatus, string> = {
  BACKLOG: "Beklemede",
  TODO: "Yapilacak",
  IN_PROGRESS: "Devam ediyor",
  BLOCKED: "Engellendi",
  IN_REVIEW: "Incelemede",
  COMPLETED: "Tamamlandi",
  CANCELLED: "Iptal edildi",
};

export const taskPriorityLabels: Record<TaskPriority, string> = {
  LOW: "Dusuk",
  MEDIUM: "Orta",
  HIGH: "Yuksek",
  CRITICAL: "Kritik",
};

export const taskActivityLabels: Record<TaskActivityAction, string> = {
  CREATED: "Gorev olusturuldu",
  UPDATED: "Gorev guncellendi",
  STATUS_CHANGED: "Durum degisti",
  PRIORITY_CHANGED: "Oncelik degisti",
  ASSIGNEE_ADDED: "Sorumlu eklendi",
  ASSIGNEE_REMOVED: "Sorumlu cikarildi",
  START_DATE_CHANGED: "Baslangic tarihi degisti",
  DUE_DATE_CHANGED: "Bitis tarihi degisti",
  COMPLETED: "Gorev tamamlandi",
  CANCELLED: "Gorev iptal edildi",
};

// A todo list is this table filtered, not a table of its own -- see the TODO
// tool and docs/authorization.md. These are the two filters that define it, so
// they live next to the statuses rather than being retyped per caller.
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "BLOCKED",
  "IN_REVIEW",
];

/** True when a task still needs someone to do something about it. */
export function isOpenTask(status: TaskStatus): boolean {
  return OPEN_TASK_STATUSES.includes(status);
}

export type Task = z.infer<typeof taskSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskAssignee = z.infer<typeof taskAssigneeSchema>;
export type TaskActivity = z.infer<typeof taskActivitySchema>;
export type TaskActivityAction = z.infer<typeof taskActivityActionSchema>;
