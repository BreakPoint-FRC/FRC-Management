import { z } from "zod";

const MAX_WINDOW_DAYS = 366;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Deliberately not paginated.
 *
 * Every other list in this API extends paginationSchema, and this one does not:
 * a calendar is asked for by window, and `page=2` of a month is half a month --
 * a grid with the back end of it missing, which is worse than an error. The
 * window and the ceiling below do the job page/pageSize does elsewhere, which is
 * to stop one request from asking for the whole table.
 *
 * A year plus a day is the ceiling because the widest thing anyone asks for is a
 * season, and a season is a year.
 */
export const calendarQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    seasonId: z.string().optional(),
    groupId: z.string().optional(),
  })
  .superRefine((query, ctx) => {
    if (query.to < query.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "Bitis tarihi baslangictan once olamaz",
      });
      return;
    }

    if (query.to.getTime() - query.from.getTime() > MAX_WINDOW_DAYS * DAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "Takvim araligi en fazla bir yil olabilir",
      });
    }
  });

export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
