import type { Prisma, PrismaClient } from "@breakpoint/db";
import {
  placementUsesAssignmentGroup,
  roleDepths,
  type AccountRoleInput,
  type RolePlacement,
} from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { hashPassword } from "../../lib/password";
import { paginated, toPrismaPage } from "../../lib/pagination";
import type {
  CreateAccountInput,
  ListAccountsQuery,
  ReplaceRolesInput,
  UpdateAccountInput,
} from "./accounts.schema";

// Roles are always read with the names needed to render them, so no caller has
// to make a second round trip to turn an id into "Programming Lead".
const withRoles = {
  roles: {
    where: { isActive: true },
    select: {
      groupId: true,
      role: { select: { id: true, key: true, name: true, placement: true } },
      group: { select: { name: true } },
    },
  },
  memberships: {
    where: { isActive: true },
    select: { group: { select: { id: true, name: true } } },
  },
} satisfies Prisma.AccountSelect;

const accountSelect = {
  id: true,
  teamId: true,
  email: true,
  fullName: true,
  isActive: true,
  mustChangePassword: true,
  createdAt: true,
  archivedAt: true,
  ...withRoles,
} satisfies Prisma.AccountSelect;

type AccountRow = Prisma.AccountGetPayload<{ select: typeof accountSelect }>;

/** Flattens the nested role rows into the shape packages/types describes. */
function serialize(account: AccountRow, depths: Map<string, number>) {
  const { roles, memberships, ...rest } = account;
  return {
    ...rest,
    roles: roles.map((entry) => ({
      roleId: entry.role.id,
      roleKey: entry.role.key,
      roleName: entry.role.name,
      placement: entry.role.placement,
      // Position in the hierarchy graph, computed on read. There is no rank
      // column to disagree with the edges any more.
      depth: depths.get(entry.role.id) ?? 0,
      groupId: entry.groupId,
      groupName: entry.group?.name ?? null,
    })),
    groups: memberships.map((entry) => entry.group),
  };
}

export function createAccountsService(prisma: PrismaClient) {
  /** Depths for the roles appearing on a page of accounts. */
  const depthsFor = async (rows: AccountRow[]) => {
    const roleIds = [...new Set(rows.flatMap((row) => row.roles.map((r) => r.role.id)))];
    if (roleIds.length === 0) return new Map<string, number>();
    const edges = await prisma.roleHierarchy.findMany({
      where: { parentRoleId: { in: roleIds }, childRoleId: { in: roleIds } },
      select: { parentRoleId: true, childRoleId: true },
    });
    return roleDepths(roleIds, edges);
  };

  const serializeMany = async (rows: AccountRow[]) => {
    const depths = await depthsFor(rows);
    return rows.map((row) => serialize(row, depths));
  };

  /**
   * The rules a role assignment has to satisfy that the request body alone
   * cannot decide, because they depend on the stored Role.
   *
   * groupId is required for an IN_GROUP role and forbidden for every other
   * placement -- the others carry their coverage on the role itself, so an
   * assignment naming a group would describe something the resolver ignores.
   * That is a conditional CHECK constraint, which Prisma cannot express and
   * which cannot be added by hand without putting the database permanently out
   * of sync with schema.prisma (docs/migrations.md). So it is enforced here,
   * and roles only ever arrive as a whole set through one endpoint --
   * **anyone adding a second way to write roles has to re-check this.**
   *
   * The role and the group both have to belong to the team as well. Without
   * that a team admin could grant one of their people a role from another team
   * by pasting its id, and inherit its permissions with it.
   */
  const assertAssignable = async (teamId: string, roles: readonly AccountRoleInput[]) => {
    if (roles.length === 0) return;

    const stored = await prisma.role.findMany({
      where: { id: { in: roles.map((entry) => entry.roleId) }, teamId },
      select: { id: true, name: true, placement: true },
    });
    const byId = new Map(stored.map((role) => [role.id, role]));

    const groupIds = [
      ...new Set(roles.map((entry) => entry.groupId).filter((id): id is string => !!id)),
    ];
    if (groupIds.length > 0) {
      const found = await prisma.group.count({ where: { id: { in: groupIds }, teamId } });
      if (found !== groupIds.length) throw new NotFoundError("Grup bulunamadi");
    }

    for (const entry of roles) {
      const role = byId.get(entry.roleId);
      if (!role) throw new NotFoundError("Rol bulunamadi");

      const placement = role.placement as RolePlacement;
      if (placementUsesAssignmentGroup(placement) && !entry.groupId) {
        throw new ConflictError(`${role.name} rolu bir grup icinde atanmali`);
      }
      if (!placementUsesAssignmentGroup(placement) && entry.groupId) {
        throw new ConflictError(
          `${role.name} rolu kapsamini kendisi tasir, ayrica bir gruba atanamaz`
        );
      }
    }
  };

  /**
   * Refuses to leave a team with no active team admin.
   *
   * There is no second way in. A team whose last TEAM_ADMIN is archived or
   * demoted cannot create accounts, edit roles or reach its own settings, and
   * fixing it means a platform admin and a database. Cheaper to refuse.
   */
  const assertNotLastAdmin = async (teamId: string, accountId: string) => {
    const remaining = await prisma.accountRole.count({
      where: {
        isActive: true,
        role: { teamId, key: "TEAM_ADMIN" },
        accountId: { not: accountId },
        account: { isActive: true, archivedAt: null },
      },
    });
    if (remaining === 0) {
      throw new ConflictError(
        "Takimin son yoneticisi kaldirilamaz, once baska bir takim yoneticisi atayin"
      );
    }
  };

  /** Whether this account currently holds the team admin role. */
  const isTeamAdmin = async (teamId: string, accountId: string) =>
    (await prisma.accountRole.count({
      where: { accountId, isActive: true, role: { teamId, key: "TEAM_ADMIN" } },
    })) > 0;

  /**
   * Replaces the whole role set, and makes sure the account is a member of
   * every group it now holds an IN_GROUP role in.
   *
   * That second part is not a convenience. authorize() requires membership
   * before an IN_GROUP role counts, so a member assigned to Yazilim without a
   * Yazilim membership would be refused from their own department -- a bug that
   * looks like a permissions problem and is not.
   *
   * Roles scoped from above (MANAGES_GROUP, ABOVE_GROUPS) create no membership:
   * a director is not a member of the departments they oversee, and inventing
   * one would put them on the roster.
   */
  const replaceRoles = async (
    teamId: string,
    accountId: string,
    roles: readonly AccountRoleInput[],
    assignedById: string
  ) => {
    await assertAssignable(teamId, roles);

    const groupIds = [
      ...new Set(roles.map((entry) => entry.groupId).filter((id): id is string => !!id)),
    ];

    await prisma.$transaction([
      prisma.accountRole.deleteMany({ where: { accountId } }),
      prisma.accountRole.createMany({
        data: roles.map((entry) => ({
          accountId,
          roleId: entry.roleId,
          groupId: entry.groupId ?? null,
          assignedById,
        })),
      }),
      ...groupIds.map((groupId) =>
        prisma.groupMembership.upsert({
          where: { accountId_groupId: { accountId, groupId } },
          update: { isActive: true },
          create: { accountId, groupId },
        })
      ),
    ]);
  };

  return {
    list: async (teamId: string, query: ListAccountsQuery) => {
      const where: Prisma.AccountWhereInput = {
        teamId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.groupId
          ? { memberships: { some: { groupId: query.groupId, isActive: true } } }
          : {}),
        ...(query.search
          ? {
              OR: [
                { fullName: { contains: query.search, mode: "insensitive" } },
                { email: { contains: query.search, mode: "insensitive" } },
              ],
            }
          : {}),
      };

      // Count and page in one transaction so the total cannot describe a
      // different set of rows than the page it is paired with.
      const [rows, total] = await prisma.$transaction([
        prisma.account.findMany({
          where,
          select: accountSelect,
          orderBy: { fullName: "asc" },
          ...toPrismaPage(query),
        }),
        prisma.account.count({ where }),
      ]);

      return paginated(await serializeMany(rows), total, query);
    },

    // Deliberately finds archived accounts too: a task still points at whoever
    // created it, and that page has to render.
    getById: async (teamId: string, id: string) => {
      const account = await prisma.account.findFirst({
        where: { id, teamId },
        select: accountSelect,
      });
      if (!account) return null;
      return (await serializeMany([account]))[0];
    },

    create: async (
      teamId: string,
      { roles, password, ...rest }: CreateAccountInput,
      assignedById: string
    ) => {
      const account = await prisma.account.create({
        data: {
          ...rest,
          teamId,
          passwordHash: await hashPassword(password),
          // Whoever typed this password is not the person who will use it, so
          // it is a way in rather than a credential. Cleared by /auth/password.
          mustChangePassword: true,
        },
        select: { id: true },
      });

      await replaceRoles(teamId, account.id, roles, assignedById);

      const created = await prisma.account.findUniqueOrThrow({
        where: { id: account.id },
        select: accountSelect,
      });
      return (await serializeMany([created]))[0];
    },

    update: async (teamId: string, id: string, input: UpdateAccountInput) => {
      const existing = await prisma.account.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError("Hesap bulunamadi");

      // Suspending the last team admin locks the team out exactly as archiving
      // it would, so it is refused the same way.
      if (input.isActive === false && (await isTeamAdmin(teamId, id))) {
        await assertNotLastAdmin(teamId, id);
      }

      const account = await prisma.account.update({
        where: { id },
        data: input,
        select: accountSelect,
      });
      return (await serializeMany([account]))[0];
    },

    replaceRoles: async (
      teamId: string,
      id: string,
      input: ReplaceRolesInput,
      assignedById: string
    ) => {
      // Fails with a 404 before anything is written, rather than creating roles
      // for an account that does not exist or belongs to another team.
      const account = await prisma.account.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!account) throw new NotFoundError("Hesap bulunamadi");

      // Losing the role is what matters, not gaining it: demoting the last team
      // admin is the same lockout as archiving them.
      const wasAdmin = await isTeamAdmin(teamId, id);
      const staysAdmin =
        input.roles.length > 0 &&
        (await prisma.role.count({
          where: { teamId, key: "TEAM_ADMIN", id: { in: input.roles.map((r) => r.roleId) } },
        })) > 0;
      if (wasAdmin && !staysAdmin) await assertNotLastAdmin(teamId, id);

      await replaceRoles(teamId, id, input.roles, assignedById);

      const updated = await prisma.account.findUniqueOrThrow({
        where: { id },
        select: accountSelect,
      });
      return (await serializeMany([updated]))[0];
    },

    /**
     * Archives rather than deletes. Everything an account touched -- tasks it
     * created, meetings it ran, money it recorded -- points at it with ON DELETE
     * RESTRICT, so a hard delete would either fail or take the history with it.
     *
     * Roles and memberships are left in place: what someone did is part of the
     * record the archive exists to preserve. isActive is cleared in the same
     * write, because someone who has left should not still be able to sign in.
     */
    archive: async (teamId: string, id: string) => {
      const account = await prisma.account.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!account) throw new NotFoundError("Hesap bulunamadi");
      if (await isTeamAdmin(teamId, id)) await assertNotLastAdmin(teamId, id);

      await prisma.$transaction([
        prisma.account.update({
          where: { id },
          data: { archivedAt: new Date(), isActive: false },
        }),
        // Their sessions end now, not whenever the refresh token happens to
        // expire.
        prisma.refreshToken.updateMany({
          where: { accountId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    },

    /**
     * Admin reset. The sessions of the account are revoked along with it, and it
     * is flagged to change the password at next sign-in: an admin who typed it
     * knows it, which is precisely what makes it temporary.
     */
    resetPassword: async (teamId: string, id: string, password: string) => {
      const account = await prisma.account.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!account) throw new NotFoundError("Hesap bulunamadi");

      await prisma.$transaction([
        prisma.account.update({
          where: { id },
          data: {
            passwordHash: await hashPassword(password),
            isActive: true,
            mustChangePassword: true,
          },
        }),
        prisma.refreshToken.updateMany({
          where: { accountId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    },
  };
}
