import { z } from "zod";

export const meetingSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  scheduledAt: z.coerce.date(),
  report: z.string().nullable(),
});

export const attendanceSchema = z.object({
  meetingId: z.string(),
  memberId: z.string(),
  present: z.boolean(),
});

export type Meeting = z.infer<typeof meetingSchema>;
export type Attendance = z.infer<typeof attendanceSchema>;
