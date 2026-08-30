import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { calendarQuerySchema } from "./calendar.schema";
import { createCalendarService } from "./calendar.service";

describe("calendar window validation", () => {
  it("accepts a month", () => {
    const result = calendarQuerySchema.safeParse({ from: "2026-08-01", to: "2026-08-31" });

    expect(result.success).toBe(true);
  });

  it("rejects a window that ends before it starts", () => {
    const result = calendarQuerySchema.safeParse({ from: "2026-09-01", to: "2026-08-01" });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["to"]);
  });

  it("rejects a window wider than a year", () => {
    // The ceiling is what stops one request asking for the whole table, since
    // this endpoint deliberately has no page/pageSize.
    const result = calendarQuerySchema.safeParse({ from: "2026-01-01", to: "2028-01-01" });

    expect(result.success).toBe(false);
  });

  it("still allows a whole season", () => {
    const result = calendarQuerySchema.safeParse({ from: "2026-01-01", to: "2026-12-31" });

    expect(result.success).toBe(true);
  });

  it("requires both ends", () => {
    expect(calendarQuerySchema.safeParse({ from: "2026-08-01" }).success).toBe(false);
  });
});

describe("assembling the window", () => {
  const SEASON = {
    id: "s1",
    name: "2026",
    startDate: new Date(2026, 0, 1),
    endDate: new Date(2026, 11, 31),
  };

  function stubPrisma(options: {
    meetings?: unknown[];
    tasks?: unknown[];
  } = {}) {
    const meetingFindMany = vi.fn().mockResolvedValue(options.meetings ?? []);
    const taskFindMany = vi.fn().mockResolvedValue(options.tasks ?? []);

    const prisma = {
      meeting: { findMany: meetingFindMany },
      task: { findMany: taskFindMany },
      season: {
        findFirst: async () => ({ id: "s1" }),
        findUnique: async () => SEASON,
      },
    } as unknown as PrismaClient;

    return { prisma, meetingFindMany, taskFindMany };
  }

  const august = calendarQuerySchema.parse({ from: "2026-08-01", to: "2026-08-31" });

  const meeting = {
    id: "m1",
    title: "Kickoff",
    meetingDate: new Date(2026, 7, 10),
    groupId: "g1",
    group: { name: "Programlama" },
  };

  it("turns a meeting into one entry", async () => {
    const { prisma } = stubPrisma({ meetings: [meeting] });

    const { items } = await createCalendarService(prisma).range(august, {
      meetings: true,
      tasks: true,
    });

    expect(items).toEqual([
      {
        kind: "MEETING",
        id: "m1",
        title: "Kickoff",
        date: new Date(2026, 7, 10),
        groupId: "g1",
        groupName: "Programlama",
        status: null,
      },
    ]);
  });

  it("gives a task both ends of its bar", async () => {
    // "This starts today" and "this is due today" are two different things to
    // know; one entry could only ever say one of them.
    const { prisma } = stubPrisma({
      tasks: [
        {
          id: "t1",
          name: "Sasi tasarimi",
          status: "IN_PROGRESS",
          startDate: new Date(2026, 7, 3),
          dueDate: new Date(2026, 7, 20),
          groupId: "g2",
          group: { name: "Mekanik" },
        },
      ],
    });

    const { items } = await createCalendarService(prisma).range(august, {
      meetings: true,
      tasks: true,
    });

    expect(items.map((item) => item.kind)).toEqual(["TASK_START", "TASK_DUE"]);
    expect(items.every((item) => item.id === "t1")).toBe(true);
    expect(items[1]?.date).toEqual(new Date(2026, 7, 20));
  });

  it("leaves out the end that falls outside the window", async () => {
    // The query matches a task on either date, so a task pulled in by its start
    // must not also draw a due marker on a day months away.
    const { prisma } = stubPrisma({
      tasks: [
        {
          id: "t2",
          name: "Sezon boyu",
          status: "TODO",
          startDate: new Date(2026, 7, 15),
          dueDate: new Date(2026, 11, 1),
          groupId: null,
          group: null,
        },
      ],
    });

    const { items } = await createCalendarService(prisma).range(august, {
      meetings: true,
      tasks: true,
    });

    expect(items.map((item) => item.kind)).toEqual(["TASK_START"]);
  });

  it("skips a task with no dates at all", async () => {
    const { prisma } = stubPrisma({
      tasks: [
        {
          id: "t3",
          name: "Tarihsiz",
          status: "BACKLOG",
          startDate: null,
          dueDate: null,
          groupId: null,
          group: null,
        },
      ],
    });

    const { items } = await createCalendarService(prisma).range(august, {
      meetings: true,
      tasks: true,
    });

    expect(items).toEqual([]);
  });

  it("sorts by day, then meetings before tasks", async () => {
    const { prisma } = stubPrisma({
      meetings: [{ ...meeting, meetingDate: new Date(2026, 7, 10) }],
      tasks: [
        {
          id: "t4",
          name: "Ayni gun",
          status: "TODO",
          startDate: new Date(2026, 7, 10),
          dueDate: null,
          groupId: null,
          group: null,
        },
        {
          id: "t5",
          name: "Once",
          status: "TODO",
          startDate: new Date(2026, 7, 2),
          dueDate: null,
          groupId: null,
          group: null,
        },
      ],
    });

    const { items } = await createCalendarService(prisma).range(august, {
      meetings: true,
      tasks: true,
    });

    expect(items.map((item) => [item.kind, item.id])).toEqual([
      ["TASK_START", "t5"],
      ["MEETING", "m1"],
      ["TASK_START", "t4"],
    ]);
  });

  it("does not query a source the caller may not read", async () => {
    // CALENDAR grants the view, not the data. Without this the calendar would
    // be a side door onto every meeting title on the team.
    const { prisma, meetingFindMany, taskFindMany } = stubPrisma({ meetings: [meeting] });

    const { items } = await createCalendarService(prisma).range(august, {
      meetings: false,
      tasks: true,
    });

    expect(meetingFindMany).not.toHaveBeenCalled();
    expect(taskFindMany).toHaveBeenCalled();
    expect(items).toEqual([]);
  });

  it("scopes both sources to the group when one is given", async () => {
    const { prisma, meetingFindMany, taskFindMany } = stubPrisma();

    await createCalendarService(prisma).range(
      calendarQuerySchema.parse({ from: "2026-08-01", to: "2026-08-31", groupId: "g1" }),
      { meetings: true, tasks: true }
    );

    expect(meetingFindMany.mock.calls[0]?.[0].where).toMatchObject({
      seasonId: "s1",
      groupId: "g1",
    });
    expect(taskFindMany.mock.calls[0]?.[0].where).toMatchObject({
      seasonId: "s1",
      groupId: "g1",
    });
  });

  it("returns the season window alongside the entries", async () => {
    const { prisma } = stubPrisma();

    const { season } = await createCalendarService(prisma).range(august, {
      meetings: true,
      tasks: true,
    });

    expect(season).toEqual(SEASON);
  });
});
