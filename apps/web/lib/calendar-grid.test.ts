import { describe, expect, it } from "vitest";
import { addMonths, dayKey, isSameMonth, monthGrid, startOfMonth } from "./calendar-grid";

const keys = (dates: Date[]) => dates.map(dayKey);

describe("monthGrid", () => {
  it("always returns six whole weeks", () => {
    // Whatever the month, the grid is the same height -- otherwise everything
    // below the calendar moves when the user pages through the year.
    for (const month of [0, 1, 5, 8, 11]) {
      expect(monthGrid(new Date(2026, month, 1))).toHaveLength(42);
    }
  });

  it("starts on the Monday of the week the 1st falls in", () => {
    // 1 August 2026 is a Saturday, so the grid opens on Monday 27 July.
    const grid = monthGrid(new Date(2026, 7, 1));

    expect(dayKey(grid[0] as Date)).toBe("2026-07-27");
    expect(grid[0]?.getDay()).toBe(1);
  });

  it("pads a month that begins on a Sunday with a full leading week", () => {
    // 1 February 2026 is a Sunday. Monday-first means six days of January in
    // front of it, not one -- the easy off-by-one in a Sunday-based getDay().
    const grid = monthGrid(new Date(2026, 1, 1));

    expect(dayKey(grid[0] as Date)).toBe("2026-01-26");
    expect(dayKey(grid[6] as Date)).toBe("2026-02-01");
  });

  it("covers every day of a 31-day month", () => {
    const grid = keys(monthGrid(new Date(2026, 0, 1)));

    expect(grid).toContain("2026-01-01");
    expect(grid).toContain("2026-01-31");
  });

  it("covers a leap February to the 29th", () => {
    const grid = keys(monthGrid(new Date(2028, 1, 1)));

    expect(grid).toContain("2028-02-29");
    expect(grid).not.toContain("2028-02-30");
  });

  it("runs consecutively with no repeated or skipped day", () => {
    // The guard on the daylight-saving bug: stepping by 24 hours instead of by
    // day-of-month repeats a date across the March boundary.
    const grid = monthGrid(new Date(2026, 2, 1));

    expect(new Set(keys(grid)).size).toBe(42);
    for (let i = 1; i < grid.length; i += 1) {
      const previous = grid[i - 1] as Date;
      const current = grid[i] as Date;
      const days = Math.round((current.getTime() - previous.getTime()) / 86_400_000);
      expect(days).toBe(1);
    }
  });
});

describe("dayKey", () => {
  it("keys by local date, not UTC", () => {
    // Late-evening dates east of Greenwich are already the next day in UTC;
    // keying on the ISO string would file them under the wrong cell.
    expect(dayKey(new Date(2026, 7, 30, 23, 30))).toBe("2026-08-30");
  });

  it("pads month and day", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("startOfMonth / addMonths / isSameMonth", () => {
  it("normalises to midnight on the first", () => {
    expect(dayKey(startOfMonth(new Date(2026, 7, 30, 14, 0)))).toBe("2026-08-01");
  });

  it("rolls over the year in both directions", () => {
    expect(dayKey(addMonths(new Date(2026, 11, 1), 1))).toBe("2027-01-01");
    expect(dayKey(addMonths(new Date(2026, 0, 1), -1))).toBe("2025-12-01");
  });

  it("does not confuse the same month in different years", () => {
    expect(isSameMonth(new Date(2026, 7, 15), new Date(2026, 7, 1))).toBe(true);
    expect(isSameMonth(new Date(2025, 7, 15), new Date(2026, 7, 1))).toBe(false);
  });
});
