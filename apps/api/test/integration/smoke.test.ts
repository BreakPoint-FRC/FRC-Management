import { expect, it } from "vitest";

import { FIXTURE_PASSWORD, as, describeIntegration, useIntegrationDatabase } from "./harness";

/**
 * One happy path per module, against a real migrated Postgres.
 *
 * The module suites in apps/api/src/modules run against a stub client, which is
 * the right seam for the rules a service applies -- but a stub answers whatever
 * the test told it to, so nothing there can fail on a constraint, an enum, a
 * Decimal column or the order two writes actually reach the database in. That
 * is the class of bug this file exists to catch, and the reason CI stands a
 * postgres:16-alpine up (see docs/migrations.md).
 *
 * It is a smoke suite, not a second copy of the module tests. Each case walks a
 * write through the HTTP surface and reads it back the way a client would; the
 * edge cases stay where they are.
 */
describeIntegration("api smoke suite", () => {
  const ctx = useIntegrationDatabase();

  // Signing a token beats logging in for most of these: /auth/login is rate
  // limited to ten attempts a minute per IP, and app.inject is always the same
  // IP. The auth case below does the real thing once.
  const admin = () => as(ctx.app, ctx.fixture.alpha.adminAccountId);
  const member = () => as(ctx.app, ctx.fixture.alpha.memberAccountId);
  const platform = () => as(ctx.app, ctx.fixture.platform.accountId);

  it("auth: signs in against the stored argon2 hash and describes the account", async () => {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: ctx.fixture.alpha.adminEmail, password: FIXTURE_PASSWORD },
    });

    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken } = login.json();
    expect(typeof accessToken).toBe("string");
    expect(typeof refreshToken).toBe("string");

    // The refresh token is stored hashed, never in clear text.
    const stored = await ctx.prisma.refreshToken.findMany({ select: { tokenHash: true } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(refreshToken);

    const me = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    const profile = me.json();
    expect(profile.account.email).toBe(ctx.fixture.alpha.adminEmail);
    expect(profile.team.id).toBe(ctx.fixture.alpha.id);
    expect(profile.permissions.global.TASKS).toMatchObject({ canRead: true, canDelete: true });
  });

  it("seasons: creates one and reads it back", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/seasons",
      headers: admin(),
      payload: {
        name: "2027 Sezonu",
        startDate: "2027-01-04T00:00:00.000Z",
        endDate: "2027-12-31T00:00:00.000Z",
        isActive: true,
      },
    });

    expect(created.statusCode).toBe(201);
    const seasonId = created.json().id;

    const read = await ctx.app.inject({
      method: "GET",
      url: `/seasons/${seasonId}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: seasonId, name: "2027 Sezonu", isActive: true });

    // Activating one deactivates the others, in the same transaction. Against a
    // stub both updateMany and update simply return what they were told to.
    const current = await ctx.app.inject({
      method: "GET",
      url: "/seasons/current",
      headers: admin(),
    });
    expect(current.json().id).toBe(seasonId);

    const active = await ctx.prisma.season.findMany({
      where: { teamId: ctx.fixture.alpha.id, isActive: true },
      select: { id: true },
    });
    expect(active).toEqual([{ id: seasonId }]);
  });

  it("groups: creates a department under another and reads the tree back", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/groups",
      headers: admin(),
      payload: { name: "Elektrik", parentId: ctx.fixture.alpha.groupId },
    });

    expect(created.statusCode).toBe(201);
    const groupId = created.json().id;

    const tree = await ctx.app.inject({ method: "GET", url: "/groups/tree", headers: admin() });
    expect(tree.statusCode).toBe(200);

    // A flat list carrying parentId; the nesting is drawn by the client. What
    // matters here is that the parent survived the write and points at a group
    // of the same team.
    const node = tree
      .json()
      .find((group: { id: string }) => group.id === groupId);
    expect(node).toMatchObject({ name: "Elektrik", parentId: ctx.fixture.alpha.groupId });
  });

  it("roles: creates one and lists it", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/roles",
      headers: admin(),
      payload: {
        key: "MEKANIK_LEAD",
        name: "Mekanik Lideri",
        placement: "MANAGES_GROUP",
        groupScopeIds: [ctx.fixture.alpha.groupId],
      },
    });

    expect(created.statusCode).toBe(201);
    const roleId = created.json().id;

    const list = await ctx.app.inject({ method: "GET", url: "/roles", headers: admin() });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((role: { id: string }) => role.id)).toContain(roleId);
  });

  it("accounts: creates one with a role and reads it back with that role resolved", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/accounts",
      headers: admin(),
      payload: {
        email: "yeni@alpha.test",
        fullName: "Yeni Uye",
        password: FIXTURE_PASSWORD,
        roles: [{ roleId: ctx.fixture.alpha.memberRoleId, groupId: ctx.fixture.alpha.groupId }],
      },
    });

    expect(created.statusCode).toBe(201);
    const accountId = created.json().id;

    const read = await ctx.app.inject({
      method: "GET",
      url: `/accounts/${accountId}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ email: "yeni@alpha.test", mustChangePassword: true });
    expect(read.json().roles).toHaveLength(1);

    // An IN_GROUP role is only honoured for an active member of that group, so
    // the service writes the membership alongside it. Without the row the new
    // account would be refused from its own department.
    const membership = await ctx.prisma.groupMembership.findFirst({
      where: { accountId, groupId: ctx.fixture.alpha.groupId },
      select: { isActive: true },
    });
    expect(membership).toEqual({ isActive: true });
  });

  it("tasks: creates one and writes its activity log in the same transaction", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: member(),
      payload: {
        name: "Sasi kaynagi",
        groupId: ctx.fixture.alpha.groupId,
        priority: "HIGH",
        startDate: "2026-02-01T00:00:00.000Z",
        dueDate: "2026-02-10T00:00:00.000Z",
        assigneeIds: [ctx.fixture.alpha.memberAccountId],
      },
    });

    expect(created.statusCode).toBe(201);
    const taskId = created.json().id;
    // Omitted seasonId resolves to the team's active season, not to null.
    expect(created.json().seasonId).toBe(ctx.fixture.alpha.seasonId);

    const read = await ctx.app.inject({
      method: "GET",
      url: `/tasks/${taskId}`,
      headers: member(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ name: "Sasi kaynagi", status: "TODO", priority: "HIGH" });
    expect(read.json().assignees).toHaveLength(1);

    // Read as the admin: the history is gated on TASK_LOGS, which is a
    // different permission from being able to see the task, and the member role
    // deliberately does not hold it.
    const activity = await ctx.app.inject({
      method: "GET",
      url: `/tasks/${taskId}/activity`,
      headers: admin(),
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().items.map((row: { action: string }) => row.action)).toContain("CREATED");
  });

  it("meetings: creates one, records the roll call, and reads both back", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/meetings",
      headers: admin(),
      payload: {
        title: "Haftalik toplanti",
        groupId: ctx.fixture.alpha.groupId,
        meetingDate: "2026-02-03T18:00:00.000Z",
        body: "# Gundem",
      },
    });

    expect(created.statusCode).toBe(201);
    const meetingId = created.json().id;

    const attendance = await ctx.app.inject({
      method: "PUT",
      url: `/meetings/${meetingId}/attendance`,
      headers: admin(),
      payload: {
        attendance: [
          { accountId: ctx.fixture.alpha.memberAccountId, status: "PRESENT" },
          { accountId: ctx.fixture.alpha.adminAccountId, status: "LATE", note: "15 dk gec" },
        ],
      },
    });
    expect(attendance.statusCode).toBe(200);

    const read = await ctx.app.inject({
      method: "GET",
      url: `/meetings/${meetingId}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().attendance).toHaveLength(2);
  });

  it("finance: a Decimal(12, 2) amount survives the round trip as the same string", async () => {
    // The exact reason the column is Decimal and the wire format is a string.
    // A stub hands back whatever it was given; only a real column can lose the
    // trailing zero on the way through.
    const created = await ctx.app.inject({
      method: "POST",
      url: "/finance",
      headers: admin(),
      payload: {
        type: "EXPENSE",
        category: "Malzeme",
        amount: "4750.50",
        transactionDate: "2026-02-04T00:00:00.000Z",
        groupId: ctx.fixture.alpha.groupId,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().amount).toBe("4750.50");

    const read = await ctx.app.inject({
      method: "GET",
      url: `/finance/${created.json().id}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().amount).toBe("4750.50");

    const summary = await ctx.app.inject({
      method: "GET",
      url: "/finance/summary",
      headers: admin(),
    });
    expect(summary.json()).toMatchObject({ expense: "4750.50", net: "-4750.50" });
  });

  it("sponsors: creates a company, then this season's relationship with it", async () => {
    const organization = await ctx.app.inject({
      method: "POST",
      url: "/sponsors/organizations",
      headers: admin(),
      payload: { name: "Ornek Sanayi", website: "https://ornek.test" },
    });
    expect(organization.statusCode).toBe(201);

    const sponsorship = await ctx.app.inject({
      method: "POST",
      url: "/sponsors/sponsorships",
      headers: admin(),
      payload: {
        organizationId: organization.json().id,
        status: "SPONSOR",
        amount: "25000.00",
      },
    });
    expect(sponsorship.statusCode).toBe(201);

    const read = await ctx.app.inject({
      method: "GET",
      url: `/sponsors/sponsorships/${sponsorship.json().id}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      status: "SPONSOR",
      amount: "25000.00",
      seasonId: ctx.fixture.alpha.seasonId,
    });
  });

  it("gantt: creates a board and orders real tasks onto it", async () => {
    const first = await createTask("Tasarim");
    const second = await createTask("Uretim");

    const board = await ctx.app.inject({
      method: "POST",
      url: "/gantt",
      headers: admin(),
      payload: { name: "Sezon plani", groupId: ctx.fixture.alpha.groupId },
    });
    expect(board.statusCode).toBe(201);

    const ordered = await ctx.app.inject({
      method: "PUT",
      url: `/gantt/${board.json().id}/tasks`,
      headers: admin(),
      payload: { taskIds: [second, first] },
    });
    expect(ordered.statusCode).toBe(200);

    const read = await ctx.app.inject({
      method: "GET",
      url: `/gantt/${board.json().id}`,
      headers: admin(),
    });
    expect(read.statusCode).toBe(200);
    // The order sent, not the order the rows happen to come back in.
    expect(read.json().tasks.map((task: { id: string }) => task.id)).toEqual([second, first]);
  });

  it("calendar: returns the meeting and the task created around the same date", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/meetings",
      headers: admin(),
      payload: {
        title: "Kickoff",
        groupId: ctx.fixture.alpha.groupId,
        meetingDate: "2026-02-05T18:00:00.000Z",
      },
    });
    await createTask("Sasi montaji", "2026-02-06T00:00:00.000Z");

    const calendar = await ctx.app.inject({
      method: "GET",
      url: "/calendar?from=2026-02-01T00:00:00.000Z&to=2026-02-28T00:00:00.000Z",
      headers: admin(),
    });

    expect(calendar.statusCode).toBe(200);
    const kinds = calendar.json().items.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toContain("MEETING");
    expect(kinds).toContain("TASK_DUE");
  });

  it("tools: lists the module catalogue the migrations own", async () => {
    const list = await ctx.app.inject({ method: "GET", url: "/tools", headers: admin() });

    expect(list.statusCode).toBe(200);
    expect(list.json().map((tool: { key: string }) => tool.key)).toContain("TASKS");
  });

  it("setup: reports where the team is in the wizard", async () => {
    const state = await ctx.app.inject({ method: "GET", url: "/setup", headers: admin() });

    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ stage: "DONE" });
    expect(state.json().team.id).toBe(ctx.fixture.alpha.id);
  });

  it("teams: a platform account opens a team, its admin, and the whole permission matrix", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/teams",
      headers: platform(),
      payload: {
        name: "Takim Gama",
        adminFullName: "Gama Yoneticisi",
        adminEmail: "admin@gama.test",
      },
    });

    expect(created.statusCode).toBe(201);
    const { team, admin: createdAdmin, temporaryPassword } = created.json();
    expect(typeof temporaryPassword).toBe("string");

    const list = await ctx.app.inject({ method: "GET", url: "/teams", headers: platform() });
    expect(list.json().items.map((row: { id: string }) => row.id)).toContain(team.id);

    // All of it is one transaction: the team, its TEAM_ADMIN role, the matrix
    // for that role, and the account holding it. Every tool but TEAMS.
    const grants = await ctx.prisma.rolePermission.count({
      where: { role: { teamId: team.id, key: "TEAM_ADMIN" } },
    });
    expect(grants).toBe(Object.keys(ctx.fixture.toolIds).length - 1);

    const assignment = await ctx.prisma.accountRole.findFirst({
      where: { accountId: createdAdmin.id },
      select: { role: { select: { key: true, teamId: true } } },
    });
    expect(assignment?.role).toEqual({ key: "TEAM_ADMIN", teamId: team.id });
  });

  async function createTask(name: string, dueDate = "2026-02-20T00:00:00.000Z"): Promise<string> {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: admin(),
      payload: { name, groupId: ctx.fixture.alpha.groupId, dueDate },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  }
});
