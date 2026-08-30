import { z } from "zod";

import { taskStatusSchema } from "./tasks";

/**
 * The calendar owns no records.
 *
 * Every entry it draws is a date that already lives on a meeting or a task, so
 * there is no Calendar table and nothing here is writable. That is the whole
 * design: a calendar with its own copy of a due date would disagree with the
 * task page the first time someone moved one, exactly as a Gantt board with its
 * own dates would (see gantt.ts).
 *
 * A task contributes up to two entries -- the two ends of its Gantt bar -- which
 * is why the kind is on the entry rather than the record.
 */
export const CALENDAR_ENTRY_KINDS = ["MEETING", "TASK_START", "TASK_DUE"] as const;

export const calendarEntryKindSchema = z.enum(CALENDAR_ENTRY_KINDS);

export const calendarEntrySchema = z.object({
  kind: calendarEntryKindSchema,
  /** The meeting or task id. The cell links straight to that record. */
  id: z.string(),
  title: z.string(),
  date: z.coerce.date(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  /** Only tasks carry one. Meetings send null rather than omitting the field. */
  status: taskStatusSchema.nullable(),
});

/**
 * A season is a range, not a day, so it is not an entry.
 *
 * It rides alongside the entries because the page needs it to say which days in
 * the window are outside the season -- greying those is the difference between
 * "nothing planned" and "nothing can be planned".
 */
export const calendarSeasonWindowSchema = z.object({
  id: z.string(),
  name: z.string(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

export const calendarRangeSchema = z.object({
  items: z.array(calendarEntrySchema),
  season: calendarSeasonWindowSchema.nullable(),
});

// A complete record, so a new kind fails typecheck until it has a label.
export const calendarEntryKindLabels: Record<CalendarEntryKind, string> = {
  MEETING: "Toplanti",
  TASK_START: "Gorev baslangici",
  TASK_DUE: "Gorev teslimi",
};

export type CalendarEntryKind = z.infer<typeof calendarEntryKindSchema>;
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;
export type CalendarSeasonWindow = z.infer<typeof calendarSeasonWindowSchema>;
export type CalendarRange = z.infer<typeof calendarRangeSchema>;
