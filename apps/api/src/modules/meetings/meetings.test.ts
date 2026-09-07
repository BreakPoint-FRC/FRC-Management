import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@breakpoint/db";

import { buildApp } from "../../app";
import { parseGrant } from "../setup/setup.template";
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
  function stubTx(
    deleteMany: ReturnType<typeof vi.fn>,
    upsert: ReturnType<typeof vi.fn>,
    groupId: string | null = null
  ) {
    return {
      meetingAttendance: { deleteMany, upsert },
      meeting: {
        findUniqueOrThrow: async () => ({
          id: "m1",
          seasonId: "s1",
          groupId,
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

  it("records someone who is no longer in the group the meeting belongs to", async () => {
    // The other half of "a saved roll call is a record, not a recomputation":
    // the web app keeps a stored attendee who has since left the group in the
    // payload, and the server has to accept them. Attendees are proved to
    // belong to the *team*; group membership is deliberately not consulted,
    // which also lets a guest at a group meeting be marked present.
    //
    // A real group meeting, not the default team-wide stub, so this actually
    // exercises "group membership is not consulted" rather than a case where
    // there was no group to consult in the first place.
    const upsert = vi.fn();
    const membershipQuery = vi.fn();
    const prisma = {
      meeting: { count: async () => 1 },
      // Both ids are this team's people, which is the whole check.
      account: { count: async () => 2 },
      groupMembership: { count: membershipQuery, findMany: membershipQuery },
      $transaction: async (fn: (client: unknown) => unknown) =>
        fn(stubTx(vi.fn(), upsert, "g1")),
    } as unknown as PrismaClient;

    await createMeetingsService(prisma).recordAttendance(TEAM, "m1", {
      attendance: [
        { accountId: "a1", status: "PRESENT" },
        { accountId: "a9", status: "PRESENT" },
      ],
    });

    expect(membershipQuery).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map((call) => call[0].where.meetingId_accountId.accountId)).toEqual([
      "a1",
      "a9",
    ]);
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
  it("writes no roll call of its own", async () => {
    // Deliberate, and the web app depends on it -- see apps/web/lib/attendance.ts.
    // A row per member written here would be a record of a roll call nobody
    // took: the list page reads `attendedCount / attendance.length`, so a
    // meeting that has not happened yet would report "0 / 14" and there would
    // be no way left to tell "not taken" from "everybody was absent". It would
    // also go stale the moment PATCH /meetings/:id moves the meeting to another
    // group, because nothing recomputes it.
    const createMany = vi.fn();
    const create = vi.fn(async () => ({
      id: "m1",
      seasonId: "s1",
      groupId: "g1",
      title: "Kickoff",
      body: null,
      meetingDate: new Date("2026-09-01"),
      createdAt: new Date("2026-09-01"),
      group: { name: "Yazilim" },
      createdBy: { id: "a1", fullName: "Ada Yilmaz" },
      attendance: [],
    }));

    const prisma = {
      season: { findFirst: async () => ({ id: "s1" }) },
      meeting: { create },
      meetingAttendance: { createMany, create: createMany, upsert: createMany },
    } as unknown as PrismaClient;

    const meeting = await createMeetingsService(prisma).create(
      TEAM,
      { title: "Kickoff", groupId: "g1", meetingDate: new Date("2026-09-01") },
      "a1"
    );

    expect(createMany).not.toHaveBeenCalled();
    expect(meeting.attendance).toEqual([]);
    // "Not taken", not "nobody came".
    expect(meeting.attendedCount).toBe(0);
  });

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

describe("who a roll call can be taken over", () => {
  it("reads a group meeting's roster from active membership, not the whole team", async () => {
    const findMany = vi.fn(async () => [
      { id: "a1", fullName: "Ada Yilmaz" },
      { id: "a2", fullName: "Deniz Kaya" },
    ]);
    const prisma = { account: { findMany } } as unknown as PrismaClient;

    await createMeetingsService(prisma).attendanceCandidates(TEAM, "g1");

    expect(findMany).toHaveBeenCalledWith({
      where: {
        teamId: TEAM,
        archivedAt: null,
        memberships: { some: { groupId: "g1", isActive: true } },
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    });
  });

  it("reads a team-wide meeting's roster as every non-archived account, unfiltered by group", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { account: { findMany } } as unknown as PrismaClient;

    await createMeetingsService(prisma).attendanceCandidates(TEAM, null);

    expect(findMany).toHaveBeenCalledWith({
      where: { teamId: TEAM, archivedAt: null },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
    });
  });
});

// #42's own review found that the roster the web app used (GET /accounts)
// needed ACCOUNTS/read, a permission independent of MEETINGS/update -- so a
// role holding one and not the other could update a meeting through the API
// and still be refused the list of people to mark. attendance-candidates
// exists to make that impossible: it is authorized against MEETINGS/update for
// the meeting's own group only, the same check the route already made to get
// this far, so there is no second permission left that could disagree with it.
describe("GET /meetings/:id/attendance-candidates authorizes independently of ACCOUNTS", () => {
  const TOOL_MEETINGS = { id: "tool-meetings", key: "MEETINGS", isActive: true };
  const TOOL_ACCOUNTS = { id: "tool-accounts", key: "ACCOUNTS", isActive: true };
  const ROLE_ID = "role-under-test";

  const ROSTER = [
    { id: "acc-lead", teamId: TEAM, fullName: "Kerem Lider", archivedAt: null as Date | null, groupId: "g1" },
    { id: "acc-member-1", teamId: TEAM, fullName: "Ada Uye", archivedAt: null as Date | null, groupId: "g1" },
    { id: "acc-member-2", teamId: TEAM, fullName: "Deniz Uye", archivedAt: null as Date | null, groupId: "g2" },
    {
      id: "acc-archived",
      teamId: TEAM,
      fullName: "Eski Uye",
      archivedAt: new Date("2026-01-01") as Date | null,
      groupId: "g1",
    },
  ];

  const MEETINGS: Record<string, { id: string; teamId: string; groupId: string | null }> = {
    "m-group": { id: "m-group", teamId: TEAM, groupId: "g1" },
    "m-team": { id: "m-team", teamId: TEAM, groupId: null },
    "m-other-team": { id: "m-other-team", teamId: "team-2", groupId: null },
  };

  function statefulApp(grants: { MEETINGS?: string; ACCOUNTS?: string }) {
    const caller = {
      id: "account-1",
      email: "lider@breakpoint.test",
      fullName: "Test Lider",
      teamId: TEAM,
      isActive: true,
      mustChangePassword: false,
      archivedAt: null,
      team: { isActive: true },
      memberships: [],
      roles: [
        {
          groupId: null,
          isActive: true,
          role: { id: ROLE_ID, key: "CUSTOM_LEAD", placement: "TEAM_WIDE", groupScopes: [] },
        },
      ],
    };

    const prisma = {
      $disconnect: vi.fn(),
      account: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === caller.id ? caller : null,
        findMany: async ({
          where,
        }: {
          where: {
            teamId: string;
            archivedAt: null;
            memberships?: { some: { groupId: string; isActive: boolean } };
          };
        }) =>
          ROSTER.filter((row) => {
            if (row.teamId !== where.teamId) return false;
            if (row.archivedAt !== null) return false;
            const wantsGroup = where.memberships?.some.groupId;
            return wantsGroup === undefined || row.groupId === wantsGroup;
          })
            .map((row) => ({ id: row.id, fullName: row.fullName }))
            .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      },
      group: {
        findMany: async () => [
          { id: "g1", parentId: null },
          { id: "g2", parentId: null },
        ],
      },
      roleHierarchy: { findMany: async () => [] },
      groupTool: { findMany: async () => [] },
      tool: {
        findUnique: async ({ where }: { where: { key: string } }) =>
          where.key === "MEETINGS" ? TOOL_MEETINGS : where.key === "ACCOUNTS" ? TOOL_ACCOUNTS : null,
      },
      rolePermission: {
        findMany: async ({ where }: { where: { roleId: { in: string[] }; toolId: string } }) => {
          if (!where.roleId.in.includes(ROLE_ID)) return [];
          if (where.toolId === TOOL_MEETINGS.id && grants.MEETINGS) return [parseGrant(grants.MEETINGS)];
          if (where.toolId === TOOL_ACCOUNTS.id && grants.ACCOUNTS) return [parseGrant(grants.ACCOUNTS)];
          return [];
        },
      },
      meeting: {
        findFirst: async ({ where }: { where: { id: string; teamId: string } }) => {
          const meeting = MEETINGS[where.id];
          if (!meeting || meeting.teamId !== where.teamId) return null;
          return { id: meeting.id, groupId: meeting.groupId };
        },
      },
    } as unknown as PrismaClient;

    return buildApp({ prisma });
  }

  async function inject(app: ReturnType<typeof buildApp>, url: string) {
    return app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: "account-1" })}` },
    });
  }

  it("lets a role with MEETINGS/update but no ACCOUNTS grant read a group meeting's roster", async () => {
    const app = statefulApp({ MEETINGS: "rcud" });
    await app.ready();

    const response = await inject(app, "/meetings/m-group/attendance-candidates");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "acc-member-1", fullName: "Ada Uye" },
      { id: "acc-lead", fullName: "Kerem Lider" },
    ]);

    // The same role really cannot read /accounts -- proving the endpoint above
    // does not depend on being able to.
    const accountsResponse = await inject(app, "/accounts");
    expect(accountsResponse.statusCode).toBe(403);

    await app.close();
  });

  it("returns every non-archived account, unfiltered by group, for a team-wide meeting", async () => {
    const app = statefulApp({ MEETINGS: "rcud" });
    await app.ready();

    const response = await inject(app, "/meetings/m-team/attendance-candidates");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: "acc-member-1", fullName: "Ada Uye" },
      { id: "acc-member-2", fullName: "Deniz Uye" },
      { id: "acc-lead", fullName: "Kerem Lider" },
    ]);

    await app.close();
  });

  it("refuses a role with no MEETINGS/update grant", async () => {
    const app = statefulApp({});
    await app.ready();

    const response = await inject(app, "/meetings/m-team/attendance-candidates");
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("answers 404 for a meeting id from another team", async () => {
    const app = statefulApp({ MEETINGS: "rcud" });
    await app.ready();

    const response = await inject(app, "/meetings/m-other-team/attendance-candidates");
    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
