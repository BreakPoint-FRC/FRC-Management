import { z } from "zod";
import { paginationSchema } from "@breakpoint/types";

const seasonFields = z.object({
  name: z.string().min(1, "Sezon adi gerekli").max(80),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  isActive: z.boolean().default(false),
});

const endsAfterItStarts = (input: { startDate?: Date; endDate?: Date }) =>
  !input.startDate || !input.endDate || input.endDate > input.startDate;

export const createSeasonSchema = seasonFields.refine(endsAfterItStarts, {
  message: "Bitis tarihi baslangictan sonra olmali",
  path: ["endDate"],
});

// Partial, so a season can be renamed without resending its dates -- but the
// date rule still has to hold when both are sent together.
export const updateSeasonSchema = seasonFields.partial().refine(endsAfterItStarts, {
  message: "Bitis tarihi baslangictan sonra olmali",
  path: ["endDate"],
});

export const listSeasonsQuerySchema = paginationSchema;

export type CreateSeasonInput = z.infer<typeof createSeasonSchema>;
export type UpdateSeasonInput = z.infer<typeof updateSeasonSchema>;
export type ListSeasonsQuery = z.infer<typeof listSeasonsQuerySchema>;
