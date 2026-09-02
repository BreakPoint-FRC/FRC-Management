import type { Prisma, PrismaClient } from "@breakpoint/db";
import { ATTENDED_STATUSES } from "@breakpoint/types";

import { resolveSeasonId } from "../../lib/active-season";
import { NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type {
  CreateMeetingInput,
  ListMeetingsQuery,
  RecordAttendanceInput,
  UpdateMeetingInput,
} from "./meetings.schema";

const meetingSelect = {
  id: true,
  seasonId: true,
  groupId: true,
  title: true,
  body: true,
  meetingDate: true,
  createdAt: true,
  group: { select: { name: true } },
  createdBy: { select: { id: true, fullName: true } },
  attendance: {
    select: {
      status: true,
      note: true,
      account: { select: { id: true, fullName: true } },
    },
  },
} satisfies Prisma.MeetingSelect;

type MeetingRow = Prisma.MeetingGetPayload<{ select: typeof meetingSelect }>;

function serialize(meeting: MeetingRow) {
  const { attendance, group, ...rest } = meeting;
  return {
    ...rest,
    groupName: group?.name ?? null,
    attendance: attendance.map((entry) => ({
      accountId: entry.account.id,
      fullName: entry.account.fullName,
      status: entry.status,
      note: entry.note,
    })),
    // Counted here rather than in the client so every surface that shows a rate
    // computes it the same way -- and "late" counts as having turned up.
    attendedCount: attendance.filter((entry) => ATTENDED_STATUSES.includes(entry.status)).length,
  };
}

export function createMeetingsService(prisma: PrismaClient) {
  return {
    list: async (teamId: string, query: ListMeetingsQuery) => {
      const where: Prisma.MeetingWhereInput = {
        teamId,
        ...(query.seasonId ? { seasonId: query.seasonId } : {}),
        ...(query.groupId ? { groupId: query.groupId } : {}),
      };

      const [rows, total] = await prisma.$transaction([
        prisma.meeting.findMany({
          where,
          select: meetingSelect,
          orderBy: { meetingDate: "desc" },
          ...toPrismaPage(query),
        }),
        prisma.meeting.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    // findFirst rather than findUnique: the team is half the identity now, and
    // (id, teamId) is not a unique index.
    getById: async (teamId: string, id: string) => {
      const meeting = await prisma.meeting.findFirst({
        where: { id, teamId },
        select: meetingSelect,
      });
      return meeting && serialize(meeting);
    },

    /**
     * Only used to decide which group to authorize a mutation against.
     *
     * Scoped to the team as well, so a route that reads the group off a stored
     * record cannot be handed another team's id and authorize against it. A
     * miss here becomes the 404 the route already raises.
     */
    groupOf: (teamId: string, id: string) =>
      prisma.meeting.findFirst({ where: { id, teamId }, select: { id: true, groupId: true } }),

    create: async (teamId: string, { seasonId, ...rest }: CreateMeetingInput, actorId: string) => {
      const resolvedSeasonId = await resolveSeasonId(prisma, teamId, seasonId);
      const meeting = await prisma.meeting.create({
        data: {
          ...rest,
          teamId,
          seasonId: resolvedSeasonId,
          createdById: actorId,
        },
        select: meetingSelect,
      });
      return serialize(meeting);
    },

    update: async (teamId: string, id: string, input: UpdateMeetingInput) => {
      const existing = await prisma.meeting.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Toplanti bulunamadi");

      const meeting = await prisma.meeting.update({
        where: { id },
        data: input,
        select: meetingSelect,
      });
      return serialize(meeting);
    },

    /**
     * Replaces the roll call.
     *
     * Anyone left out of the list is dropped, not silently kept: the list is
     * what was taken in the room, and a name that survived from a previous
     * save would be a record of attendance nobody actually observed.
     */
    recordAttendance: async (
      teamId: string,
      meetingId: string,
      input: RecordAttendanceInput
    ) => {
      const keep = input.attendance.map((entry) => entry.accountId);

      const meetingExists = await prisma.meeting.count({ where: { id: meetingId, teamId } });
      if (meetingExists === 0) throw new NotFoundError("Toplanti bulunamadi");

      // Attendees have to be this team's own people. Without this an id from
      // another team would land on the roll call and read as a member.
      if (keep.length > 0) {
        const found = await prisma.account.count({ where: { id: { in: keep }, teamId } });
        if (found !== new Set(keep).size) throw new NotFoundError("Hesap bulunamadi");
      }

      const meeting = await prisma.$transaction(async (tx) => {
        await tx.meetingAttendance.deleteMany({
          where: { meetingId, accountId: { notIn: keep } },
        });

        for (const entry of input.attendance) {
          await tx.meetingAttendance.upsert({
            where: { meetingId_accountId: { meetingId, accountId: entry.accountId } },
            update: { status: entry.status, note: entry.note ?? null },
            create: {
              meetingId,
              accountId: entry.accountId,
              status: entry.status,
              note: entry.note ?? null,
            },
          });
        }

        return tx.meeting.findUniqueOrThrow({ where: { id: meetingId }, select: meetingSelect });
      });

      return serialize(meeting);
    },

    /**
     * Hard delete, cascading the attendance rows.
     *
     * A meeting that did not happen is worth removing; one that did is worth
     * keeping, and there is no soft-delete flag here because "we met and then
     * un-met" is not a thing. Deleting is gated on the MEETINGS delete
     * permission, which in practice only leads and above hold.
     */
    remove: async (teamId: string, id: string) => {
      const existing = await prisma.meeting.count({ where: { id, teamId } });
      if (existing === 0) throw new NotFoundError("Toplanti bulunamadi");
      await prisma.meeting.delete({ where: { id } });
    },
  };
}
