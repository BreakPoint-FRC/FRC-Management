import type { PrismaClient } from "@breakpoint/db";
import type { CalendarEntryKind, TaskStatus } from "@breakpoint/types";

import { resolveSeasonId } from "../../lib/active-season";
import type { CalendarQuery } from "./calendar.schema";

interface CalendarEntry {
  kind: CalendarEntryKind;
  id: string;
  title: string;
  date: Date;
  groupId: string | null;
  groupName: string | null;
  status: TaskStatus | null;
}

/**
 * Which sources the caller is allowed to see.
 *
 * Decided by the route from the account's MEETINGS and TASKS permissions, not
 * here -- the service draws what it is told to draw. See calendar.routes.ts for
 * why the two are checked separately.
 */
export interface CalendarSources {
  meetings: boolean;
  tasks: boolean;
}

const KIND_ORDER: Record<CalendarEntryKind, number> = {
  MEETING: 0,
  TASK_START: 1,
  TASK_DUE: 2,
};

export function createCalendarService(prisma: PrismaClient) {
  return {
    /**
     * Everything dated inside the window.
     *
     * Nothing here is stored: a meeting contributes its meetingDate and a task
     * contributes whichever of its two dates fall in the window, so a due date
     * moved on the task page has already moved on the calendar. The same rule
     * the Gantt board follows, for the same reason.
     */
    range: async (teamId: string, query: CalendarQuery, sources: CalendarSources) => {
      const seasonId = await resolveSeasonId(prisma, teamId, query.seasonId);
      const window = { gte: query.from, lte: query.to };

      // An absent groupId is "every group", not "the team-wide ones": the route
      // has already established the caller may read across departments. It is
      // still one team's every group -- teamId is the outer bound on both
      // queries below.
      const scope = {
        teamId,
        seasonId,
        ...(query.groupId ? { groupId: query.groupId } : {}),
      };

      const [meetings, tasks, season] = await Promise.all([
        sources.meetings
          ? prisma.meeting.findMany({
              where: { ...scope, meetingDate: window },
              select: {
                id: true,
                title: true,
                meetingDate: true,
                groupId: true,
                group: { select: { name: true } },
              },
            })
          : Promise.resolve([]),

        sources.tasks
          ? prisma.task.findMany({
              // One query for both ends of the bar. A task whose start is in the
              // window but whose due date is months later still belongs here,
              // and so does the reverse, so neither date can be the filter on
              // its own.
              where: {
                ...scope,
                OR: [{ startDate: window }, { dueDate: window }],
              },
              select: {
                id: true,
                name: true,
                status: true,
                startDate: true,
                dueDate: true,
                groupId: true,
                group: { select: { name: true } },
              },
            })
          : Promise.resolve([]),

        prisma.season.findUnique({
          where: { id: seasonId },
          select: { id: true, name: true, startDate: true, endDate: true },
        }),
      ]);

      const items: CalendarEntry[] = [];

      for (const meeting of meetings) {
        items.push({
          kind: "MEETING",
          id: meeting.id,
          title: meeting.title,
          date: meeting.meetingDate,
          groupId: meeting.groupId,
          groupName: meeting.group?.name ?? null,
          status: null,
        });
      }

      // A task can land twice, once per end. That is the point rather than a
      // duplicate: "this starts today" and "this is due today" are two different
      // things to know, and a single entry could only say one of them.
      for (const task of tasks) {
        const common = {
          id: task.id,
          title: task.name,
          groupId: task.groupId,
          groupName: task.group?.name ?? null,
          status: task.status,
        };

        if (inWindow(task.startDate, query)) {
          items.push({ ...common, kind: "TASK_START", date: task.startDate as Date });
        }
        if (inWindow(task.dueDate, query)) {
          items.push({ ...common, kind: "TASK_DUE", date: task.dueDate as Date });
        }
      }

      items.sort(
        (a, b) =>
          a.date.getTime() - b.date.getTime() ||
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          a.title.localeCompare(b.title, "tr")
      );

      return { items, season };
    },
  };
}

/**
 * The OR above matches a task on either date, so each one still has to be
 * checked before it becomes an entry -- otherwise a task pulled in by its due
 * date would also draw a start marker on a day months outside the window.
 */
function inWindow(date: Date | null, query: CalendarQuery): boolean {
  return date !== null && date >= query.from && date <= query.to;
}
