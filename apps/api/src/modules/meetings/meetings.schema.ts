import { z } from "zod";

export const createMeetingSchema = z.object({
  title: z.string().min(1),
  scheduledAt: z.coerce.date(),
});

export const updateReportSchema = z.object({
  report: z.string(),
});

export const rollCallSchema = z.object({
  attendance: z.array(
    z.object({
      memberId: z.string(),
      present: z.boolean(),
    })
  ),
});

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateReportInput = z.infer<typeof updateReportSchema>;
export type RollCallInput = z.infer<typeof rollCallSchema>;
