import { z } from "zod";

// A boolean could only say present or absent, which is not what roll call
// records. "Late" and "excused" are the two the team actually argues about.
export const attendanceStatusSchema = z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED"]);

export const meetingSchema = z.object({
  id: z.string(),
  seasonId: z.string(),
  // Null means a team-wide meeting. The roadmap has both that and per-group
  // meeting reports, and a null group is what sends the authorization check
  // down the GLOBAL path.
  groupId: z.string().nullable(),
  title: z.string().min(1),
  body: z.string().nullable(),
  meetingDate: z.coerce.date(),
});

export const meetingAttendanceSchema = z.object({
  accountId: z.string().min(1),
  status: attendanceStatusSchema,
  note: z.string().max(500).nullish(),
});

export const attendanceStatusLabels: Record<AttendanceStatus, string> = {
  PRESENT: "Katildi",
  ABSENT: "Katilmadi",
  LATE: "Gec geldi",
  EXCUSED: "Izinli",
};

/** Statuses that count as having shown up, for attendance rates. */
export const ATTENDED_STATUSES: readonly AttendanceStatus[] = ["PRESENT", "LATE"];

export type Meeting = z.infer<typeof meetingSchema>;
export type MeetingAttendance = z.infer<typeof meetingAttendanceSchema>;
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;
