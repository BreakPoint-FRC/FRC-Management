/**
 * The month grid, as dates.
 *
 * Kept out of the page because date arithmetic written inline is where
 * off-by-one-day bugs live, and because this is the one part of a calendar that
 * can be tested without rendering anything.
 *
 * Six rows always, never five: a grid that changes height as the user pages
 * through the year makes everything below it jump.
 */

const WEEKS = 6;
const DAYS_IN_WEEK = 7;

/** Monday first, the way a Turkish calendar is read. */
export const WEEKDAY_LABELS = ["Pzt", "Sal", "Car", "Per", "Cum", "Cmt", "Paz"] as const;

/** Midnight local time on the first of the month `date` falls in. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** `delta` months from `date`, keeping to the first of the month. */
export function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

/**
 * 42 consecutive days: the month, padded out to whole weeks at both ends.
 *
 * The padding days belong to the neighbouring months and the page greys them,
 * but they are real dates and carry their real entries -- a meeting on the 31st
 * of the previous month is still visible in the top row, which is the point of
 * showing them at all.
 */
export function monthGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor);

  // getDay() is Sunday-based; this shifts it so Monday is 0.
  const lead = (first.getDay() + 6) % DAYS_IN_WEEK;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);

  return Array.from(
    { length: WEEKS * DAYS_IN_WEEK },
    // Adding to the day-of-month rather than to a timestamp: over a daylight
    // saving boundary a 24-hour step lands at 23:00 the previous day, and the
    // grid would show a date twice.
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
  );
}

/** "2026-08-30" in local time -- the key entries are bucketed under. */
export function dayKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

export function isSameMonth(date: Date, cursor: Date): boolean {
  return date.getFullYear() === cursor.getFullYear() && date.getMonth() === cursor.getMonth();
}
