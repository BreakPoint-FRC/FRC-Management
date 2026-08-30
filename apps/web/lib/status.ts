import type { AttendanceStatus, SponsorshipStatus, TaskStatus } from "@breakpoint/types";

/**
 * Which badge colour a status gets.
 *
 * Kept together rather than beside each page so the same meaning reads the same
 * everywhere: green is finished or confirmed, amber is in flight, red is
 * stopped or refused, grey is dormant. Complete records, so adding an enum
 * value fails typecheck until it has been given a colour.
 */
export type Tone = "ok" | "warn" | "danger" | "off";

export const taskStatusTone: Record<TaskStatus, Tone> = {
  BACKLOG: "off",
  TODO: "warn",
  IN_PROGRESS: "warn",
  BLOCKED: "danger",
  IN_REVIEW: "warn",
  COMPLETED: "ok",
  CANCELLED: "off",
};

export const attendanceTone: Record<AttendanceStatus, Tone> = {
  PRESENT: "ok",
  // Late still counts as having turned up -- ATTENDED_STATUSES says so, and the
  // colour should not disagree with the attendance rate.
  LATE: "warn",
  EXCUSED: "off",
  ABSENT: "danger",
};

export const sponsorshipTone: Record<SponsorshipStatus, Tone> = {
  SPONSOR: "ok",
  NEGOTIATING: "warn",
  CONTACTED: "warn",
  CANDIDATE: "off",
  REJECTED: "danger",
  INACTIVE: "off",
};

/**
 * The same four meanings as a chart fill.
 *
 * A badge tints a background behind dark text; a Gantt bar is a solid shape on
 * the card surface, so the two need different values for the same idea -- hence
 * a second record rather than reusing `--ok-bg`. The tones still map one to one,
 * so a task's bar and its badge can never say different things.
 *
 * These are the reserved status colours, and red against green is nearly
 * invisible to a deuteranope (deltaE 4.1). That is why every row on the chart
 * prints its status label next to the task name: the colour is a faster reading
 * of something already written down, never the only one.
 */
export const toneChartColor: Record<Tone, string> = {
  ok: "var(--chart-ok)",
  warn: "var(--chart-warn)",
  danger: "var(--chart-danger)",
  off: "var(--chart-off)",
};

export function taskStatusChartColor(status: TaskStatus): string {
  return toneChartColor[taskStatusTone[status]];
}
