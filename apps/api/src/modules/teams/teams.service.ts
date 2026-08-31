import { randomBytes } from "node:crypto";

import type { Prisma, PrismaClient } from "@breakpoint/db";
import {
  generateTemporaryPassword,
  slugifyTeamName,
  type CreateTeamInput,
  type UpdateTeamInput,
} from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { paginated, toPrismaPage } from "../../lib/pagination";
import { hashPassword } from "../../lib/password";
import type { CreateTeamAdminInput, ListTeamsQuery } from "./teams.schema";

const teamSelect = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  setupStage: true,
  setupCompletedAt: true,
  createdAt: true,
  _count: { select: { accounts: true, groups: true } },
} satisfies Prisma.TeamSelect;

type TeamRow = Prisma.TeamGetPayload<{ select: typeof teamSelect }>;

function serialize(team: TeamRow) {
  const { _count, ...rest } = team;
  return { ...rest, accountCount: _count.accounts, groupCount: _count.groups };
}

export function createTeamsService(prisma: PrismaClient) {
  /**
   * A slug that is free, by appending a counter when the natural one is taken.
   *
   * Two teams may legitimately be called the same thing -- FRC numbers them,
   * people do not -- so a collision is an ordinary event and not an error to
   * push back onto whoever is typing.
   */
  const freeSlug = async (name: string): Promise<string> => {
    const base = slugifyTeamName(name) || "takim";
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
      const taken = await prisma.team.count({ where: { slug: candidate } });
      if (taken === 0) return candidate;
    }
    // Exhausting a hundred variants means something is wrong upstream, and a
    // random tail is a better answer than a loop that never ends.
    return `${base}-${randomBytes(4).toString("hex")}`;
  };

  /**
   * Creates an account holding the team admin role, with a password the caller
   * has to read back to its owner.
   *
   * The password is returned exactly once, from the call that made it. Nothing
   * stores it and no later request can retrieve it -- there is no mail sending
   * in this project, so the only copy is on the screen of whoever created the
   * account.
   */
  const createAdmin = async (
    tx: Prisma.TransactionClient,
    teamId: string,
    input: CreateTeamAdminInput,
    assignedById: string
  ) => {
    const taken = await tx.account.count({ where: { email: input.email } });
    if (taken > 0) {
      // Email is unique across the whole platform, not per team: one address is
      // one person is one team. Saying so plainly beats a bare unique-violation.
      throw new ConflictError("Bu e-posta adresi baska bir hesapta kullaniliyor");
    }

    const role = await tx.role.findFirst({
      where: { teamId, key: "TEAM_ADMIN" },
      select: { id: true },
    });
    if (!role) throw new NotFoundError("Takim yoneticisi rolu bulunamadi");

    const password = generateTemporaryPassword(randomBytes);
    const account = await tx.account.create({
      data: {
        teamId,
        email: input.email,
        fullName: input.fullName,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      },
      select: { id: true, email: true, fullName: true },
    });

    await tx.accountRole.create({
      data: { accountId: account.id, roleId: role.id, assignedById },
    });

    return { account, password };
  };

  return {
    list: async (query: ListTeamsQuery) => {
      const where: Prisma.TeamWhereInput = query.includeInactive ? {} : { isActive: true };

      const [rows, total] = await prisma.$transaction([
        prisma.team.findMany({
          where,
          select: teamSelect,
          orderBy: { name: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.team.count({ where }),
      ]);

      return paginated(rows.map(serialize), total, query);
    },

    getById: async (id: string) => {
      const team = await prisma.team.findUnique({ where: { id }, select: teamSelect });
      return team && serialize(team);
    },

    /**
     * Opens a team and the account that will set it up.
     *
     * The name given here is a draft. The wizard asks for it again at the
     * NAMING step and rewrites it, because the groups created in the first step
     * already need a teamId to hang from -- there has to be a Team row before
     * there is a considered answer to what it is called.
     *
     * TEAM_ADMIN is created with the team rather than by a migration. A
     * migration runs once against every database; a team is created whenever
     * someone asks for one, and it needs its administrator to exist by the time
     * the first person signs in.
     *
     * All of it is one transaction. A team with no admin is unreachable, and a
     * half-created one would have to be cleaned up by hand.
     */
    create: async (input: CreateTeamInput, createdById: string) => {
      const slug = await freeSlug(input.name);

      const { team, admin } = await prisma.$transaction(async (tx) => {
        const created = await tx.team.create({
          data: { name: input.name, slug, createdById, setupStage: "GROUPS" },
          select: { id: true },
        });

        const role = await tx.role.create({
          data: {
            teamId: created.id,
            key: "TEAM_ADMIN",
            name: "Takim Yoneticisi",
            description:
              "Takimin tamamini yonetir: gruplar, roller, moduller, izinler ve hesaplar.",
            placement: "TEAM_WIDE",
            isSystemRole: true,
          },
          select: { id: true },
        });

        // Every tool except TEAMS, granted outright rather than by inheritance:
        // the power of the team admin must not depend on the shape of a role
        // tree that the team admin can edit. Running a team does not include
        // opening new ones, which is why TEAMS is left out.
        const tools = await tx.tool.findMany({
          where: { key: { not: "TEAMS" } },
          select: { id: true },
        });
        await tx.rolePermission.createMany({
          data: tools.map((tool) => ({
            roleId: role.id,
            toolId: tool.id,
            canRead: true,
            canCreate: true,
            canUpdate: true,
            canDelete: true,
          })),
        });

        const created_admin = await createAdmin(
          tx,
          created.id,
          { fullName: input.adminFullName, email: input.adminEmail },
          createdById
        );

        return { team: created, admin: created_admin };
      });

      const row = await prisma.team.findUniqueOrThrow({
        where: { id: team.id },
        select: teamSelect,
      });

      return {
        team: serialize(row),
        admin: admin.account,
        // Shown once, by the caller, and never again. See createAdmin.
        temporaryPassword: admin.password,
      };
    },

    update: async (id: string, input: UpdateTeamInput) => {
      const existing = await prisma.team.findUnique({ where: { id }, select: { name: true } });
      if (!existing) throw new NotFoundError("Takim bulunamadi");

      const team = await prisma.team.update({
        where: { id },
        data: {
          name: input.name,
          // The slug follows the name, but only when the name actually changes:
          // rewriting it on every save would churn a value that is meant to be
          // stable enough to appear in a URL.
          ...(input.name !== existing.name ? { slug: await freeSlug(input.name) } : {}),
        },
        select: teamSelect,
      });
      return serialize(team);
    },

    addAdmin: async (teamId: string, input: CreateTeamAdminInput, assignedById: string) => {
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { isActive: true },
      });
      if (!team) throw new NotFoundError("Takim bulunamadi");
      if (!team.isActive) throw new ConflictError("Arsivlenmis takima yonetici eklenemez");

      const created = await prisma.$transaction((tx) =>
        createAdmin(tx, teamId, input, assignedById)
      );
      return { admin: created.account, temporaryPassword: created.password };
    },

    /**
     * Archives a team rather than deleting it.
     *
     * Every operational row cascades from Team, so a hard delete would take a
     * season of work with it on one mistyped id. Accounts are RESTRICT and
     * would refuse anyway -- deliberately, because the people are the part that
     * must not vanish quietly.
     */
    archive: async (id: string) => {
      const team = await prisma.team.findUnique({ where: { id }, select: { isActive: true } });
      if (!team) throw new NotFoundError("Takim bulunamadi");
      if (!team.isActive) throw new ConflictError("Takim zaten arsivlenmis");

      await prisma.$transaction([
        prisma.team.update({ where: { id }, data: { isActive: false } }),
        // Sessions end now. An archived team whose members can still work for
        // fifteen minutes is not archived.
        prisma.account.updateMany({ where: { teamId: id }, data: { isActive: false } }),
        prisma.refreshToken.updateMany({
          where: { account: { teamId: id }, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    },
  };
}
