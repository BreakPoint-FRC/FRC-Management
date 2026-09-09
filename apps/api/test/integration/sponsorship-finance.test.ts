import { expect, it } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import type { RolePlacement } from "@breakpoint/types";

import { createSetupService } from "../../src/modules/setup/setup.service";

import { as, describeIntegration, useIntegrationDatabase } from "./harness";

/**
 * Issue #26: converting a SPONSOR-status sponsorship into finance income,
 * exactly once, through POST /sponsors/sponsorships/:id/finance-transaction.
 *
 * Proved against a real Postgres because the core guarantee -- at most one
 * FinanceTransaction per sponsorship -- is a @@unique constraint the service
 * only pre-checks, and a stub cannot be wrong about a race the way a real
 * database can be right about it.
 */
describeIntegration("sponsorship -> finance conversion", () => {
  const ctx = useIntegrationDatabase();

  const admin = () => as(ctx.app, ctx.fixture.alpha.adminAccountId);
  const member = () => as(ctx.app, ctx.fixture.alpha.memberAccountId);

  /** A role with exactly the given ToolKey -> flag-string grants, TEAM_WIDE. */
  async function roleWithGrants(
    prisma: PrismaClient,
    key: string,
    grants: Record<string, string>,
    placement: RolePlacement = "TEAM_WIDE"
  ) {
    const role = await prisma.role.create({
      data: { teamId: ctx.fixture.alpha.id, key, name: key, placement },
      select: { id: true },
    });
    for (const [tool, flags] of Object.entries(grants)) {
      await prisma.rolePermission.create({
        data: {
          roleId: role.id,
          toolId: ctx.fixture.toolIds[tool as keyof typeof ctx.fixture.toolIds],
          canRead: flags.includes("r"),
          canCreate: flags.includes("c"),
          canUpdate: flags.includes("u"),
          canDelete: flags.includes("d"),
        },
      });
    }
    const account = await prisma.account.create({
      data: {
        teamId: ctx.fixture.alpha.id,
        email: `${key.toLowerCase()}@alpha.test`,
        fullName: key,
        passwordHash: "unused-in-these-tests",
      },
      select: { id: true },
    });
    await prisma.accountRole.create({ data: { accountId: account.id, roleId: role.id } });
    return account.id;
  }

  async function sponsorSponsorship(status: "SPONSOR" | "CANDIDATE" = "SPONSOR") {
    const organization = await ctx.prisma.organization.create({
      data: { teamId: ctx.fixture.alpha.id, name: "Acme Robotik" },
      select: { id: true },
    });
    const sponsorship = await ctx.prisma.sponsorship.create({
      data: {
        teamId: ctx.fixture.alpha.id,
        organizationId: organization.id,
        seasonId: ctx.fixture.alpha.seasonId,
        status,
        amount: "25000.00",
      },
      select: { id: true },
    });
    return { organizationId: organization.id, sponsorshipId: sponsorship.id };
  }

  function convert(headers: { authorization: string }, sponsorshipId: string, body?: object) {
    return ctx.app.inject({
      method: "POST",
      url: `/sponsors/sponsorships/${sponsorshipId}/finance-transaction`,
      headers,
      payload: body ?? {
        amount: "25000.00",
        transactionDate: "2026-09-09",
        description: "2026 sezonu sponsorluk odemesi",
      },
    });
  }

  // --- Roles and permissions ------------------------------------------------

  it("the team admin (SPONSORS+FINANCE full) converts", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    const response = await convert(admin(), sponsorshipId);
    expect(response.statusCode).toBe(201);
  });

  it("a captain-shaped role (SPONSORS: r, FINANCE: rc) converts without SPONSORS/update", async () => {
    const accountId = await roleWithGrants(ctx.prisma, "TEST_CAPTAIN", {
      SPONSORS: "r",
      FINANCE: "rc",
    });
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(as(ctx.app, accountId), sponsorshipId);
    expect(response.statusCode).toBe(201);
  });

  it("an EXTERNAL, mentor-shaped role (SPONSORS: r, FINANCE: rc) converts", async () => {
    const accountId = await roleWithGrants(
      ctx.prisma,
      "TEST_MENTOR",
      { SPONSORS: "r", FINANCE: "rc" },
      "EXTERNAL"
    );
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(as(ctx.app, accountId), sponsorshipId);
    expect(response.statusCode).toBe(201);
  });

  it("the check is by grant, never by role name or key", async () => {
    const accountId = await roleWithGrants(ctx.prisma, "COMPLETELY_UNRELATED_KEY", {
      SPONSORS: "r",
      FINANCE: "rc",
    });
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(as(ctx.app, accountId), sponsorshipId);
    expect(response.statusCode).toBe(201);
  });

  it("403 with SPONSORS but no FINANCE/create", async () => {
    const accountId = await roleWithGrants(ctx.prisma, "TEST_SPONSORS_ONLY", {
      SPONSORS: "r",
      FINANCE: "r",
    });
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(as(ctx.app, accountId), sponsorshipId);
    expect(response.statusCode).toBe(403);
  });

  it("403 with FINANCE/create but no SPONSORS/read", async () => {
    const accountId = await roleWithGrants(ctx.prisma, "TEST_FINANCE_ONLY", { FINANCE: "rc" });
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(as(ctx.app, accountId), sponsorshipId);
    expect(response.statusCode).toBe(403);
  });

  it("403 for an account with neither grant", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    const response = await convert(member(), sponsorshipId);
    expect(response.statusCode).toBe(403);
  });

  it("a group-scoped FINANCE grant cannot convert -- the result is always team-wide", async () => {
    // MANAGES_GROUP, not TEAM_WIDE: this role's FINANCE/create only counts
    // inside its own department, and the endpoint checks with no groupId.
    const accountId = await roleWithGrants(
      ctx.prisma,
      "TEST_GROUP_TREASURER",
      { SPONSORS: "r", FINANCE: "rc" },
      "MANAGES_GROUP"
    );
    await ctx.prisma.roleGroupScope.create({
      data: {
        roleId: (
          await ctx.prisma.role.findFirstOrThrow({
            where: { teamId: ctx.fixture.alpha.id, key: "TEST_GROUP_TREASURER" },
            select: { id: true },
          })
        ).id,
        groupId: ctx.fixture.alpha.groupId,
      },
    });
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(as(ctx.app, accountId), sponsorshipId);
    expect(response.statusCode).toBe(403);
  });

  // --- Conversion behaviour --------------------------------------------------

  it("converts a SPONSOR-status sponsorship into a fixed-shape income row", async () => {
    const { sponsorshipId } = await sponsorSponsorship();

    const response = await convert(admin(), sponsorshipId);
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.type).toBe("INCOME");
    expect(body.category).toBe("Sponsorluk");
    expect(body.groupId).toBeNull();
    expect(body.seasonId).toBe(ctx.fixture.alpha.seasonId);
    expect(body.sponsorshipId).toBe(sponsorshipId);
    expect(body.amount).toBe("25000.00");

    const row = await ctx.prisma.financeTransaction.findUnique({ where: { sponsorshipId } });
    expect(row).not.toBeNull();
    expect(row?.teamId).toBe(ctx.fixture.alpha.id);
  });

  it("409 for a sponsorship that is not SPONSOR yet", async () => {
    const { sponsorshipId } = await sponsorSponsorship("CANDIDATE");
    const response = await convert(admin(), sponsorshipId);
    expect(response.statusCode).toBe(409);

    expect(await ctx.prisma.financeTransaction.count({ where: { sponsorshipId } })).toBe(0);
  });

  it("409 on a second conversion of the same sponsorship", async () => {
    const { sponsorshipId } = await sponsorSponsorship();

    const first = await convert(admin(), sponsorshipId);
    expect(first.statusCode).toBe(201);

    const second = await convert(admin(), sponsorshipId);
    expect(second.statusCode).toBe(409);

    expect(await ctx.prisma.financeTransaction.count({ where: { sponsorshipId } })).toBe(1);
  });

  it("404, not 403, for another team's sponsorship id", async () => {
    const organization = await ctx.prisma.organization.create({
      data: { teamId: ctx.fixture.beta.id, name: "Beta Firma" },
      select: { id: true },
    });
    const sponsorship = await ctx.prisma.sponsorship.create({
      data: {
        teamId: ctx.fixture.beta.id,
        organizationId: organization.id,
        seasonId: ctx.fixture.beta.seasonId,
        status: "SPONSOR",
        amount: "10000.00",
      },
      select: { id: true },
    });

    const response = await convert(admin(), sponsorship.id);
    expect(response.statusCode).toBe(404);
  });

  it("exactly one of many concurrent conversions succeeds, and only one row is ever created", async () => {
    const { sponsorshipId } = await sponsorSponsorship();

    const attempts = Array.from({ length: 10 }, () => convert(admin(), sponsorshipId));
    const codes = (await Promise.all(attempts)).map((response) => response.statusCode);

    expect(codes.filter((code) => code === 201)).toHaveLength(1);
    expect(codes.filter((code) => code === 409)).toHaveLength(9);

    const rows = await ctx.prisma.financeTransaction.findMany({ where: { sponsorshipId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sponsorshipId).toBe(sponsorshipId);
  });

  // --- Reading the link back --------------------------------------------------

  it("the sponsors list shows the finance link, and the finance list shows the sponsor", async () => {
    const { sponsorshipId, organizationId } = await sponsorSponsorship();
    await convert(admin(), sponsorshipId);

    const sponsors = await ctx.app.inject({
      method: "GET",
      url: "/sponsors/organizations?pageSize=100",
      headers: admin(),
    });
    const org = sponsors.json().items.find((item: { id: string }) => item.id === organizationId);
    const linked = org.sponsorships.find((entry: { id: string }) => entry.id === sponsorshipId);
    expect(linked.financeTransaction).toMatchObject({ amount: "25000.00" });

    const finance = await ctx.app.inject({
      method: "GET",
      url: "/finance?pageSize=100",
      headers: admin(),
    });
    const transaction = finance
      .json()
      .items.find((item: { sponsorshipId: string | null }) => item.sponsorshipId === sponsorshipId);
    expect(transaction.source).toMatchObject({ sponsorshipId, organizationId, organizationName: "Acme Robotik" });
  });

  // --- Deletion rules ----------------------------------------------------------

  it("409 deleting a sponsorship with a linked finance record", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    await convert(admin(), sponsorshipId);

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/sponsors/sponsorships/${sponsorshipId}`,
      headers: admin(),
    });
    expect(response.statusCode).toBe(409);

    expect(await ctx.prisma.sponsorship.count({ where: { id: sponsorshipId } })).toBe(1);
  });

  it("deleting the finance record frees the sponsorship for reconversion", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    const created = await convert(admin(), sponsorshipId);
    const transactionId = created.json().id;

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/finance/${transactionId}`,
      headers: admin(),
    });
    expect(removed.statusCode).toBe(204);

    const reconverted = await convert(admin(), sponsorshipId);
    expect(reconverted.statusCode).toBe(201);
    expect(reconverted.json().id).not.toBe(transactionId);
  });

  // --- Editing a linked finance record ------------------------------------

  it("amount, date and description stay editable on a linked record", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    const created = await convert(admin(), sponsorshipId);
    const transactionId = created.json().id;

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/finance/${transactionId}`,
      headers: admin(),
      payload: { amount: "24000.00", transactionDate: "2026-09-10", description: "Gecikmeli odeme" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().amount).toBe("24000.00");
  });

  it("409 changing type, category or group on a linked record", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    const created = await convert(admin(), sponsorshipId);
    const transactionId = created.json().id;

    for (const payload of [
      { type: "EXPENSE" },
      { category: "Bagis" },
      { groupId: ctx.fixture.alpha.groupId },
    ]) {
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/finance/${transactionId}`,
        headers: admin(),
        payload,
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it("resending the same type and category is not treated as a change", async () => {
    const { sponsorshipId } = await sponsorSponsorship();
    const created = await convert(admin(), sponsorshipId);
    const transactionId = created.json().id;

    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/finance/${transactionId}`,
      headers: admin(),
      payload: { type: "INCOME", category: "Sponsorluk", amount: "25000.00" },
    });
    expect(response.statusCode).toBe(200);
  });

  // --- FINANCE is a separate grant from SPONSORS -----------------------------

  it("SPONSORS/read without FINANCE/read sees that a sponsorship converted, not the amount or date", async () => {
    const sponsorsOnly = await roleWithGrants(ctx.prisma, "TEST_SPONSORS_NO_FINANCE_READ", {
      SPONSORS: "r",
    });
    const { sponsorshipId, organizationId } = await sponsorSponsorship();
    await convert(admin(), sponsorshipId);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/sponsors/organizations?pageSize=100",
      headers: as(ctx.app, sponsorsOnly),
    });
    expect(list.statusCode).toBe(200);
    const org = list.json().items.find((item: { id: string }) => item.id === organizationId);
    const linked = org.sponsorships.find((entry: { id: string }) => entry.id === sponsorshipId);
    expect(linked.financeTransaction.id).toBeTruthy();
    expect(linked.financeTransaction.amount).toBeNull();
    expect(linked.financeTransaction.transactionDate).toBeNull();

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/sponsors/sponsorships/${sponsorshipId}`,
      headers: as(ctx.app, sponsorsOnly),
    });
    expect(detail.json().financeTransaction.amount).toBeNull();

    // The same rows, seen by an account that also holds FINANCE/read, carry
    // the real numbers -- proving the redaction above is about the viewer's
    // grant, not something missing from the data itself.
    const withFinanceRead = await roleWithGrants(ctx.prisma, "TEST_SPONSORS_AND_FINANCE_READ", {
      SPONSORS: "r",
      FINANCE: "r",
    });
    const seenWithFinance = await ctx.app.inject({
      method: "GET",
      url: `/sponsors/sponsorships/${sponsorshipId}`,
      headers: as(ctx.app, withFinanceRead),
    });
    expect(seenWithFinance.json().financeTransaction).toMatchObject({ amount: "25000.00" });
  });

  // --- The real FRC_ROLE_TEMPLATE, not a synthetic stand-in -------------------

  it("FRC_ROLE_TEMPLATE grants TEAM_LEAD and MENTOR exactly SPONSORS:r + FINANCE:rc, and both work end to end", async () => {
    // A fresh team, not the shared fixture: applyTemplate refuses a team that
    // already has non-system roles, which fixture.ts's MEMBER role is.
    const team = await ctx.prisma.team.create({
      data: { name: "Sablon Takimi", slug: `sablon-${Date.now()}` },
      select: { id: true },
    });
    // applyTemplate refuses a team with no groups yet; this one's id is never
    // needed again since none of the roles this test cares about are
    // MANAGES_GROUP-scoped.
    await ctx.prisma.group.create({ data: { teamId: team.id, name: "Genel" } });
    const season = await ctx.prisma.season.create({
      data: {
        teamId: team.id,
        name: "2026 Sezonu",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-12-31T00:00:00.000Z"),
        isActive: true,
      },
      select: { id: true },
    });

    // The template itself, applied by the real setup service -- not hand-rolled
    // RolePermission rows -- so this proves setup.template.ts actually produces
    // what the sponsors/finance endpoints need, not just that the endpoints
    // work when told the right permissions exist.
    await createSetupService(ctx.prisma).applyTemplate(team.id, ctx.fixture.platform.accountId);

    const teamLeadRole = await ctx.prisma.role.findFirstOrThrow({
      where: { teamId: team.id, key: "TEAM_LEAD" },
      select: {
        id: true,
        placement: true,
        permissions: { select: { canRead: true, canCreate: true, canUpdate: true, canDelete: true, tool: { select: { key: true } } } },
      },
    });
    const mentorRole = await ctx.prisma.role.findFirstOrThrow({
      where: { teamId: team.id, key: "MENTOR" },
      select: {
        id: true,
        placement: true,
        permissions: { select: { canRead: true, canCreate: true, canUpdate: true, canDelete: true, tool: { select: { key: true } } } },
      },
    });

    const grantOn = (role: typeof teamLeadRole, toolKey: string) =>
      role.permissions.find((permission) => permission.tool.key === toolKey);

    expect(teamLeadRole.placement).toBe("TEAM_WIDE");
    expect(grantOn(teamLeadRole, "SPONSORS")).toMatchObject({
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    });
    expect(grantOn(teamLeadRole, "FINANCE")).toMatchObject({
      canRead: true,
      canCreate: true,
      canUpdate: false,
      canDelete: false,
    });

    // EXTERNAL, unchanged by this PR -- see setup.template.ts's own comment on
    // why a mentor is not TEAM_WIDE.
    expect(mentorRole.placement).toBe("EXTERNAL");
    expect(grantOn(mentorRole, "SPONSORS")).toMatchObject({ canRead: true, canCreate: false });
    expect(grantOn(mentorRole, "FINANCE")).toMatchObject({ canRead: true, canCreate: true });

    const teamLeadAccount = await ctx.prisma.account.create({
      data: { teamId: team.id, email: "kaptan@sablon.test", fullName: "Kaptan", passwordHash: "x" },
      select: { id: true },
    });
    await ctx.prisma.accountRole.create({ data: { accountId: teamLeadAccount.id, roleId: teamLeadRole.id } });

    const mentorAccount = await ctx.prisma.account.create({
      data: { teamId: team.id, email: "mentor@sablon.test", fullName: "Mentor", passwordHash: "x" },
      select: { id: true },
    });
    await ctx.prisma.accountRole.create({ data: { accountId: mentorAccount.id, roleId: mentorRole.id } });

    // TEAM_LEAD converts a real sponsorship through the real template's grants.
    const organization = await ctx.prisma.organization.create({
      data: { teamId: team.id, name: "Sablon Sponsoru" },
      select: { id: true },
    });
    const sponsorship = await ctx.prisma.sponsorship.create({
      data: {
        teamId: team.id,
        organizationId: organization.id,
        seasonId: season.id,
        status: "SPONSOR",
        amount: "5000.00",
      },
      select: { id: true },
    });
    const converted = await convert(as(ctx.app, teamLeadAccount.id), sponsorship.id, {
      amount: "5000.00",
      transactionDate: "2026-09-09",
    });
    expect(converted.statusCode).toBe(201);

    // Both TEAM_LEAD and MENTOR can also enter an ordinary, unlinked team-wide
    // finance record -- FINANCE: "c" was never scoped to the conversion
    // endpoint alone.
    for (const accountId of [teamLeadAccount.id, mentorAccount.id]) {
      const manual = await ctx.app.inject({
        method: "POST",
        url: "/finance",
        headers: as(ctx.app, accountId),
        payload: {
          type: "EXPENSE",
          category: "Malzeme",
          amount: "150.00",
          transactionDate: "2026-09-09",
        },
      });
      expect(manual.statusCode).toBe(201);
    }

    // Not asserted here: whether MENTOR's team-wide FINANCE:create also
    // authorizes a *department*-scoped record (POST /finance with a groupId).
    // Checked directly against authorize()'s TEAM_WIDE/EXTERNAL bypass
    // (apps/api/src/lib/authorize.ts): the bypass returns as soon as the
    // account holds the grant in the team-wide bucket, before it ever looks at
    // the request's groupId -- so today an EXTERNAL role's team-wide grant
    // authorizes a group-scoped write exactly like a TEAM_WIDE role's does.
    // That is pre-existing behavior of authorize(), not something this PR
    // changes, and it is arguably in tension with EXTERNAL's own doc comment
    // ("can only authorize team-wide requests") -- worth its own issue rather
    // than a silent assumption baked into this test.
  });
});
