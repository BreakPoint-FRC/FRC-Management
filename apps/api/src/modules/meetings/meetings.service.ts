import type { PrismaClient } from "@breakpoint/db";
import type {
  CreateMeetingInput,
  RollCallInput,
  UpdateReportInput,
} from "./meetings.schema";

export function createMeetingsService(prisma: PrismaClient) {
  return {
    list: () => prisma.meeting.findMany({ orderBy: { scheduledAt: "desc" } }),

    getById: (id: string) =>
      prisma.meeting.findUnique({
        where: { id },
        include: { attendance: true },
      }),

    create: (input: CreateMeetingInput) => prisma.meeting.create({ data: input }),

    // report storage & editor
    updateReport: (id: string, input: UpdateReportInput) =>
      prisma.meeting.update({ where: { id }, data: { report: input.report } }),

    // roll call
    recordAttendance: (meetingId: string, input: RollCallInput) =>
      prisma.$transaction(
        input.attendance.map(({ memberId, present }) =>
          prisma.attendance.upsert({
            where: { meetingId_memberId: { meetingId, memberId } },
            create: { meetingId, memberId, present },
            update: { present },
          })
        )
      ),
  };
}
