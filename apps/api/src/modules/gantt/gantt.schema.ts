import { z } from "zod";
import { paginationSchema } from "@breakpoint/types";

const boardFields = z.object({
  seasonId: z.string().min(1).optional(),
  groupId: z.string().min(1).nullish(),
  name: z.string().min(1, "Pano adi gerekli").max(120),
});

export const createBoardSchema = boardFields;
export const updateBoardSchema = boardFields.omit({ seasonId: true }).partial();

// Ordering only. There is deliberately nowhere here to put a date or a status:
// those live on the task, and a board that carried its own copy would drift
// from the work it is drawing the moment either changed.
export const replaceBoardTasksSchema = z.object({
  taskIds: z.array(z.string().min(1)).superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Bu gorev panoda zaten var",
        });
      }
      seen.add(id);
    });
  }),
});

export const listBoardsQuerySchema = paginationSchema.extend({
  seasonId: z.string().optional(),
  groupId: z.string().optional(),
});

export type CreateBoardInput = z.infer<typeof createBoardSchema>;
export type UpdateBoardInput = z.infer<typeof updateBoardSchema>;
export type ReplaceBoardTasksInput = z.infer<typeof replaceBoardTasksSchema>;
export type ListBoardsQuery = z.infer<typeof listBoardsQuerySchema>;
