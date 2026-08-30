import { z } from "zod";
import { attendanceStatusSchema, paginationSchema } from "@breakpoint/types";

const meetingFields = z.object({
  seasonId: z.string().min(1).optional(),
  // Null is a team-wide meeting; the roadmap has both those and per-group ones.
  groupId: z.string().min(1).nullish(),
  title: z.string().min(1, "Toplanti basligi gerekli").max(200),
  // The report body. Markdown, stored as written -- rendering is the web app's
  // problem, not the database's.
  body: z.string().max(50000).nullish(),
  meetingDate: z.coerce.date(),
});

export const createMeetingSchema = meetingFields;
export const updateMeetingSchema = meetingFields.omit({ seasonId: true }).partial();

// Roll call arrives whole. A meeting has one attendance list, and sending it
// entry by entry would leave a half-recorded roll call that reads as "everyone
// after the third person was absent".
export const recordAttendanceSchema = z.object({
  attendance: z
    .array(
      z.object({
        accountId: z.string().min(1),
        status: attendanceStatusSchema,
        note: z.string().max(500).nullish(),
      })
    )
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.accountId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "accountId"],
            message: "Bu kisi yoklamada zaten var",
          });
        }
        seen.add(entry.accountId);
      });
    }),
});

export const listMeetingsQuerySchema = paginationSchema.extend({
  seasonId: z.string().optional(),
  groupId: z.string().optional(),
});

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>;
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuerySchema>;
