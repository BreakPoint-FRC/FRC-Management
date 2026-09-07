import { expect, it } from "vitest";

import { FIXTURE_PASSWORD, as, describeIntegration, useIntegrationDatabase } from "./harness";

/**
 * The answers the API gives when a request is refused, proved against a real
 * Postgres rather than a stub that was told what to say.
 *
 * Every case here needs something a stub cannot supply: a constraint the
 * database enforces, a transaction the database rolls back, two requests
 * genuinely racing each other, or a row written straight into a table that no
 * service would ever write.
 */
describeIntegration("api guards", () => {
  const ctx = useIntegrationDatabase();

  const admin = () => as(ctx.app, ctx.fixture.alpha.adminAccountId);
  const member = () => as(ctx.app, ctx.fixture.alpha.memberAccountId);
  const platform = () => as(ctx.app, ctx.fixture.platform.accountId);

  it("409 when a real unique constraint refuses the write", async () => {
    // Season names are unique per team (@@unique([teamId, name])). The service
    // does not pre-check it; the constraint does, and the error handler turns
    // Prisma's P2002 into a 409.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/seasons",
      headers: admin(),
      payload: {
        name: ctx.fixture.alpha.seasonName,
        startDate: "2027-01-04T00:00:00.000Z",
        endDate: "2027-12-31T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("Conflict");
    // Nothing leaks about the constraint or the driver.
    expect(response.body).not.toMatch(/P2002|prisma|Season_teamId_name_key/i);

    const seasons = await ctx.prisma.season.count({ where: { teamId: ctx.fixture.alpha.id } });
    expect(seasons).toBe(1);
  });

  it("409 when the same name is unique per team but free in another", async () => {
    // The other half of @@unique([teamId, name]): the constraint is scoped, so
    // the second team may keep its own season of the same name.
    const both = await ctx.prisma.season.count({ where: { name: ctx.fixture.alpha.seasonName } });
    expect(both).toBe(2);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/seasons",
      headers: as(ctx.app, ctx.fixture.beta.adminAccountId),
      payload: {
        name: "2027 Sezonu",
        startDate: "2027-01-04T00:00:00.000Z",
        endDate: "2027-12-31T00:00:00.000Z",
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it("404, not 403, for a real id that belongs to another team", async () => {
    // A 403 would confirm the id exists. The id here is a genuine row written
    // by the fixture, not a made-up string, which is the only way to tell the
    // two answers apart.
    const response = await ctx.app.inject({
      method: "GET",
      url: `/seasons/${ctx.fixture.beta.seasonId}`,
      headers: admin(),
    });

    expect(response.statusCode).toBe(404);

    // And the row really is there, so the 404 is the tenant boundary talking.
    const exists = await ctx.prisma.season.count({ where: { id: ctx.fixture.beta.seasonId } });
    expect(exists).toBe(1);
  });

  it("404 when a write names another team's group, without touching it", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: admin(),
      payload: { name: "Sizinti", groupId: ctx.fixture.beta.groupId },
    });

    expect(response.statusCode).toBe(404);
    const leaked = await ctx.prisma.task.count({ where: { groupId: ctx.fixture.beta.groupId } });
    expect(leaked).toBe(0);
  });

  it("403 when the account is known and the permission is not there", async () => {
    // The member role holds TASKS read/create/update and nothing on ACCOUNTS.
    const listAccounts = await ctx.app.inject({
      method: "GET",
      url: "/accounts",
      headers: member(),
    });
    expect(listAccounts.statusCode).toBe(403);

    // Same account, same tool, one flag further: create is granted, delete is
    // not, and the resolution runs against real RolePermission rows.
    const created = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: member(),
      payload: { name: "Silinemeyecek gorev", groupId: ctx.fixture.alpha.groupId },
    });
    expect(created.statusCode).toBe(201);

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/tasks/${created.json().id}`,
      headers: member(),
    });
    expect(deleted.statusCode).toBe(403);

    const survived = await ctx.prisma.task.count({ where: { id: created.json().id } });
    expect(survived).toBe(1);
  });

  it("403 when the department has the module switched off", async () => {
    // Tools are inherited down the group tree, and a row on the child overrides
    // the one above it. Only a real tree with real rows can show that.
    await ctx.prisma.groupTool.create({
      data: {
        groupId: ctx.fixture.alpha.childGroupId,
        toolId: ctx.fixture.toolIds.TASKS,
        isEnabled: false,
      },
    });
    await ctx.prisma.groupMembership.create({
      data: {
        accountId: ctx.fixture.alpha.memberAccountId,
        groupId: ctx.fixture.alpha.childGroupId,
      },
    });
    await ctx.prisma.accountRole.create({
      data: {
        accountId: ctx.fixture.alpha.memberAccountId,
        roleId: ctx.fixture.alpha.memberRoleId,
        groupId: ctx.fixture.alpha.childGroupId,
      },
    });

    const inChild = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: member(),
      payload: { name: "Kapali modul", groupId: ctx.fixture.alpha.childGroupId },
    });
    expect(inChild.statusCode).toBe(403);

    // The parent, where the tool is on, still answers.
    const inParent = await ctx.app.inject({
      method: "POST",
      url: "/tasks",
      headers: member(),
      payload: { name: "Acik modul", groupId: ctx.fixture.alpha.groupId },
    });
    expect(inParent.statusCode).toBe(201);
  });

  it("rolls the whole transaction back when one write inside it fails", async () => {
    // POST /teams writes the team, its TEAM_ADMIN role, that role's whole
    // permission matrix and the admin account in one interactive transaction.
    // An email already in use fails the last of those. Against a stub the
    // earlier writes are just recorded calls; here they have to be gone.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/teams",
      headers: platform(),
      payload: {
        name: "Yarim Kalan Takim",
        adminFullName: "Cakisan Yonetici",
        adminEmail: ctx.fixture.alpha.adminEmail,
      },
    });

    expect(response.statusCode).toBe(409);

    expect(await ctx.prisma.team.count({ where: { name: "Yarim Kalan Takim" } })).toBe(0);
    // Nor the role, the matrix or the account that would have hung off it.
    expect(await ctx.prisma.role.count({ where: { team: { name: "Yarim Kalan Takim" } } })).toBe(0);
    expect(await ctx.prisma.account.count({ where: { fullName: "Cakisan Yonetici" } })).toBe(0);
    expect(await ctx.prisma.account.count({ where: { email: ctx.fixture.alpha.adminEmail } })).toBe(
      1
    );
  });

  it("lets exactly one of several concurrent identical writes through", async () => {
    // Five requests, one constraint. The service checks nothing beforehand, so
    // what decides the winner is @@unique([teamId, name]) in Postgres -- and
    // that is only true when there is a Postgres. The losers must come back as
    // an ordinary 409, not a 500 carrying a driver error.
    const attempts = Array.from({ length: 5 }, () =>
      ctx.app.inject({
        method: "POST",
        url: "/seasons",
        headers: admin(),
        payload: {
          name: "Ayni Anda Sezon",
          startDate: "2027-01-04T00:00:00.000Z",
          endDate: "2027-12-31T00:00:00.000Z",
        },
      })
    );

    const codes = (await Promise.all(attempts)).map((response) => response.statusCode);

    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    expect(codes.filter((code) => code === 409)).toHaveLength(4);

    const rows = await ctx.prisma.season.count({
      where: { teamId: ctx.fixture.alpha.id, name: "Ayni Anda Sezon" },
    });
    expect(rows).toBe(1);
  });

  it("refuses a replayed refresh token and ends every live session with it", async () => {
    const first = await rotate(await signIn());

    // Spending the same token twice is indistinguishable from theft, so it
    // revokes everything -- including the token the legitimate rotation just
    // issued. That is three rows in two tables agreeing with each other, which
    // is exactly what a stub cannot be wrong about.
    const replay = await rotate(first.spent);
    expect(replay.response.statusCode).toBe(401);

    const stillGood = await rotate(first.issued);
    expect(stillGood.response.statusCode).toBe(401);

    const live = await ctx.prisma.refreshToken.count({
      where: { accountId: ctx.fixture.alpha.adminAccountId, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it("refuses a TEAMS grant written straight into the database", async () => {
    // The escalation requirePlatform exists for. authorize() decides on
    // RolePermission rows and cannot tell a platform role from a team-wide role
    // a team wrote for itself, so a TEAMS grant on TEAM_ADMIN passes it. The
    // route check reads the account instead, and an account with a teamId is
    // refused whatever any row says.
    //
    // Written with Prisma rather than through PUT /roles/:id/permissions on
    // purpose: that endpoint refuses TEAMS, and the point is that the guarantee
    // does not depend on it having refused.
    await ctx.prisma.rolePermission.create({
      data: {
        roleId: ctx.fixture.alpha.adminRoleId,
        toolId: ctx.fixture.toolIds.TEAMS,
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      },
    });

    for (const request of [
      { method: "GET" as const, url: "/teams" },
      { method: "POST" as const, url: "/teams" },
    ]) {
      const response = await ctx.app.inject({
        ...request,
        headers: admin(),
        payload: {
          name: "Kacak Takim",
          adminFullName: "Kacak Yonetici",
          adminEmail: "kacak@ornek.test",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe("Bu islem platform hesabiyla yapilir");
    }

    expect(await ctx.prisma.team.count({ where: { name: "Kacak Takim" } })).toBe(0);

    // And /auth/me does not offer the link either: an unexercisable grant is a
    // menu of dead ends, so the matrix masks it.
    const me = await ctx.app.inject({ method: "GET", url: "/auth/me", headers: admin() });
    expect(me.json().permissions.global.TEAMS).toEqual({
      canRead: false,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    });

    // The platform account, holding the same grant, is answered.
    const allowed = await ctx.app.inject({ method: "GET", url: "/teams", headers: platform() });
    expect(allowed.statusCode).toBe(200);
  });

  async function signIn(): Promise<string> {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: ctx.fixture.alpha.adminEmail, password: FIXTURE_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return response.json().refreshToken;
  }

  async function rotate(refreshToken: string) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    return {
      response,
      spent: refreshToken,
      issued: response.statusCode === 200 ? response.json().refreshToken : "",
    };
  }
});
