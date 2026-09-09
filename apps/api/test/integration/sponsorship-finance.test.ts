import { expect, it } from "vitest";
import type { PrismaClient } from "@breakpoint/db";
import type { RolePlacement } from "@breakpoint/types";

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
});
