import { z } from "zod";
import { paginationSchema, taskPrioritySchema, taskStatusSchema } from "@breakpoint/types";

const accountIdList = z.array(z.string().min(1)).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "Bu kisi zaten listede var",
      });
    }
    seen.add(id);
  });
});

const taskFields = z.object({
  // Omitted means the active season. Nobody creating a task in March is
  // thinking about which season it belongs to.
  seasonId: z.string().min(1).optional(),
  // Null is a cross-group task, which the V1 scope has. It is not the same as
  // omitted on a PATCH, so this is nullish rather than optional.
  groupId: z.string().min(1).nullish(),
  name: z.string().min(1, "Gorev adi gerekli").max(200),
  description: z.string().max(5000).nullish(),
  startDate: z.coerce.date().nullish(),
  dueDate: z.coerce.date().nullish(),
  status: taskStatusSchema.default("TODO"),
  priority: taskPrioritySchema.default("MEDIUM"),
  assigneeIds: accountIdList.default([]),
});

const dueAfterStart = (input: { startDate?: Date | null; dueDate?: Date | null }) =>
  !input.startDate || !input.dueDate || input.dueDate >= input.startDate;

export const createTaskSchema = taskFields.refine(dueAfterStart, {
  message: "Bitis tarihi baslangictan once olamaz",
  path: ["dueDate"],
});

// assigneeIds is not updatable here: it is a set with its own endpoint, so that
// adding someone to a task and renaming it produce separate activity entries
// instead of one indistinguishable "updated".
export const updateTaskSchema = taskFields
  .omit({ assigneeIds: true, seasonId: true })
  .partial()
  .refine(dueAfterStart, {
    message: "Bitis tarihi baslangictan once olamaz",
    path: ["dueDate"],
  });

export const replaceAssigneesSchema = z.object({ accountIds: accountIdList });

export const listTasksQuerySchema = paginationSchema.extend({
  seasonId: z.string().optional(),
  groupId: z.string().optional(),
  // Repeatable: ?status=TODO&status=IN_PROGRESS
  status: z
    .union([taskStatusSchema, z.array(taskStatusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  priority: z
    .union([taskPrioritySchema, z.array(taskPrioritySchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  assigneeId: z.string().optional(),
  // The todo list. There is no Todo table -- a todo list is this table filtered
  // to the work that is not finished, so the two can never disagree about what
  // is outstanding.
  open: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ReplaceAssigneesInput = z.infer<typeof replaceAssigneesSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
