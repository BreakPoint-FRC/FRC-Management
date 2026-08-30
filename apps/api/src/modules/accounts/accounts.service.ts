import type { Prisma, PrismaClient } from "@breakpoint/db";
import type { AccountRoleInput } from "@breakpoint/types";

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
      role: {
        select: { id: true, key: true, name: true, scope: true, hierarchyLevel: true },
      },
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
  email: true,
  fullName: true,
  isActive: true,
  createdAt: true,
  archivedAt: true,
  ...withRoles,
} satisfies Prisma.AccountSelect;

type AccountRow = Prisma.AccountGetPayload<{ select: typeof accountSelect }>;

/** Flattens the nested role rows into the shape packages/types describes. */
function serialize(account: AccountRow) {
  const { roles, memberships, ...rest } = account;
  return {
    ...rest,
    roles: roles.map((entry) => ({
      roleId: entry.role.id,
      roleKey: entry.role.key,
      roleName: entry.role.name,
      scope: entry.role.scope,
      hierarchyLevel: entry.role.hierarchyLevel,
      groupId: entry.groupId,
      groupName: entry.group?.name ?? null,
    })),
    groups: memberships.map((entry) => entry.group),
  };
}

export function createAccountsService(prisma: PrismaClient) {
  /**
   * The rules a role assignment has to satisfy that the request body alone
   * cannot decide, because they depend on the stored Role.
   *
   * groupId is required for a GROUP-scoped role and forbidden for a GLOBAL one.
   * That is a conditional CHECK constraint, which Prisma cannot express and
   * which cannot be added by hand without putting the database permanently out
   * of sync with schema.prisma (docs/migrations.md). So it is enforced here,
   * and roles only ever arrive as a whole set through one endpoint --
   * **anyone adding a second way to write roles has to re-check this.**
   */
  const assertAssignable = async (roles: readonly AccountRoleInput[]) => {
    if (roles.length === 0) return;

    const stored = await prisma.role.findMany({
      where: { id: { in: roles.map((entry) => entry.roleId) } },
      select: { id: true, name: true, scope: true },
    });
    const byId = new Map(stored.map((role) => [role.id, role]));

    for (const entry of roles) {
      const role = byId.get(entry.roleId);
      if (!role) throw new NotFoundError("Rol bulunamadi");

      if (role.scope === "GROUP" && !entry.groupId) {
        throw new ConflictError(`${role.name} rolu bir grup icinde atanmali`);
      }
      if (role.scope === "GLOBAL" && entry.groupId) {
        throw new ConflictError(`${role.name} takim geneli bir rol, gruba atanamaz`);
      }
    }
  };

  /**
   * Replaces the whole role set, and makes sure the account is a member of
   * every group it now holds a role in.
   *
   * That second part is not a convenience. Step 4 of the authorization check
   * asks whether the account is in the group, so a lead assigned to Programming
   * without a Programming membership would be refused from their own
   * department -- a bug that looks like a permissions problem and is not.
   */
  const replaceRoles = async (
    accountId: string,
    roles: readonly AccountRoleInput[],
    assignedById: string
  ) => {
    await assertAssignable(roles);

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
    list: async (query: ListAccountsQuery) => {
      const where: Prisma.AccountWhereInput = {
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

      return paginated(rows.map(serialize), total, query);
    },

    // Deliberately finds archived accounts too: a task still points at whoever
    // created it, and that page has to render.
    getById: async (id: string) => {
      const account = await prisma.account.findUnique({ where: { id }, select: accountSelect });
      return account && serialize(account);
    },

    create: async ({ roles, password, ...rest }: CreateAccountInput, assignedById: string) => {
      const account = await prisma.account.create({
        data: { ...rest, passwordHash: await hashPassword(password) },
        select: { id: true },
      });

      await replaceRoles(account.id, roles, assignedById);

      const created = await prisma.account.findUniqueOrThrow({
        where: { id: account.id },
        select: accountSelect,
      });
      return serialize(created);
    },

    update: async (id: string, input: UpdateAccountInput) => {
      const account = await prisma.account.update({
        where: { id },
        data: input,
        select: accountSelect,
      });
      return serialize(account);
    },

    replaceRoles: async (id: string, input: ReplaceRolesInput, assignedById: string) => {
      // Fails with a 404 before anything is written, rather than creating roles
      // for an account that does not exist.
      await prisma.account.findUniqueOrThrow({ where: { id }, select: { id: true } });
      await replaceRoles(id, input.roles, assignedById);

      const account = await prisma.account.findUniqueOrThrow({
        where: { id },
        select: accountSelect,
      });
      return serialize(account);
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
    archive: async (id: string) => {
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

    /** Admin reset. The account's sessions are revoked along with it. */
    resetPassword: async (id: string, password: string) => {
      await prisma.$transaction([
        prisma.account.update({
          where: { id },
          data: { passwordHash: await hashPassword(password), isActive: true },
        }),
        prisma.refreshToken.updateMany({
          where: { accountId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    },
  };
}
