import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { recordAttendanceSchema } from "./meetings.schema";
import { createMeetingsService } from "./meetings.service";

// Every service call is scoped to a team now. The id itself is arbitrary; what
// the tests pin is that it reaches the query.
const TEAM = "team-1";

describe("roll call payload validation", () => {
  it("accepts the four attendance statuses", async () => {
    const result = recordAttendanceSchema.safeParse({
      attendance: [
        { accountId: "a1", status: "PRESENT" },
        { accountId: "a2", status: "ABSENT" },
        { accountId: "a3", status: "LATE", note: "Servis gecikti." },
        { accountId: "a4", status: "EXCUSED", note: "Sinav." },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a boolean where a status belongs", async () => {
    // The old model stored `present: boolean`, which could not say "late" or
    // "excused" -- most of what roll call is actually recording.
    const result = recordAttendanceSchema.safeParse({
      attendance: [{ accountId: "a1", present: true }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects the same person twice, pointing at the entry", async () => {
    const result = recordAttendanceSchema.safeParse({
      attendance: [
        { accountId: "a1", status: "PRESENT" },
        { accountId: "a1", status: "ABSENT" },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["attendance", 1, "accountId"]);
  });
});

describe("recording attendance", () => {
  function stubTx(deleteMany: ReturnType<typeof vi.fn>, upsert: ReturnType<typeof vi.fn>) {
    return {
      meetingAttendance: { deleteMany, upsert },
      meeting: {
        findUniqueOrThrow: async () => ({
          id: "m1",
          seasonId: "s1",
          groupId: null,
          title: "Kickoff",
          body: null,
          meetingDate: new Date("2026-09-01"),
          createdAt: new Date("2026-09-01"),
          group: null,
          createdBy: { id: "a1", fullName: "Ada Yilmaz" },
          attendance: [
            { status: "PRESENT", note: null, account: { id: "a1", fullName: "Ada" } },
            { status: "LATE", note: null, account: { id: "a2", fullName: "Deniz" } },
            { status: "ABSENT", note: null, account: { id: "a3", fullName: "Emre" } },
          ],
        }),
      },
    };
  }

  it("drops anyone left out of the submitted list", async () => {
    // The list is what was taken in the room. A name surviving from a previous
    // save would be a record of attendance nobody observed.
    const deleteMany = vi.fn();
    const upsert = vi.fn();
    const prisma = {
      // The service proves the meeting and every attendee belong to the team
      // before it writes anything, so the stub has to answer both counts.
      meeting: { count: async () => 1 },
      account: { count: async () => 1 },
      $transaction: async (fn: (client: unknown) => unknown) => fn(stubTx(deleteMany, upsert)),
    } as unknown as PrismaClient;

    await createMeetingsService(prisma).recordAttendance(TEAM, "m1", {
      attendance: [{ accountId: "a1", status: "PRESENT" }],
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { meetingId: "m1", accountId: { notIn: ["a1"] } },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("counts late as having turned up", async () => {
    const prisma = {
      meeting: { count: async () => 1 },
      account: { count: async () => 1 },
      $transaction: async (fn: (client: unknown) => unknown) => fn(stubTx(vi.fn(), vi.fn())),
    } as unknown as PrismaClient;

    const meeting = await createMeetingsService(prisma).recordAttendance(TEAM, "m1", {
      attendance: [{ accountId: "a1", status: "PRESENT" }],
    });

    // PRESENT + LATE, not ABSENT.
    expect(meeting.attendedCount).toBe(2);
  });
});

describe("creating a meeting", () => {
  it("refuses when there is no active season to attach it to", async () => {
    const prisma = {
      season: { findFirst: async () => null },
      meeting: { create: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      createMeetingsService(prisma).create(
        TEAM,
        { title: "Kickoff", meetingDate: new Date("2026-09-01") },
        "a1"
      )
    ).rejects.toThrow(/Aktif sezon yok/);
  });
});
