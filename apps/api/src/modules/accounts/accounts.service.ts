import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "@breakpoint/db";
import {
  generateTemporaryPassword,
  placementUsesAssignmentGroup,
  roleDepths,
  type AccountRoleInput,
  type RolePlacement,
} from "@breakpoint/types";

import { ConflictError, NotFoundError } from "../../lib/http-errors";
import { auditValuesEqual, writeAuditLog } from "../../lib/audit-log";
import { parseAccountsCsv } from "../../lib/csv";
import { hashPassword } from "../../lib/password";
import { paginated, toPrismaPage } from "../../lib/pagination";
import {
  bulkImportRowSchema,
  type CreateAccountInput,
  type ListAccountsQuery,
  type ReplaceRolesInput,
  type UpdateAccountInput,
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

// Argon2 is intentionally memory-hard. Starting 250 hashes at once would turn
// that protection into a multi-gigabyte burst inside the API process. Four
// workers keep the CPU busy without letting one authorized import starve the
// rest of the server.
const PASSWORD_HASH_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index]!, index);
      }
    })
  );

  return results;
}

function auditRoles(roles: readonly AccountRoleInput[]): Prisma.InputJsonValue {
  return roles
    .map((entry) => ({ roleId: entry.roleId, groupId: entry.groupId ?? null }))
    .sort(
      (left, right) =>
        left.roleId.localeCompare(right.roleId) ||
        (left.groupId ?? "").localeCompare(right.groupId ?? "")
    );
}

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
      if (found !== groupIds.length) throw new NotFoundError("Grup bulunamadı");
    }

    for (const entry of roles) {
      const role = byId.get(entry.roleId);
      if (!role) throw new NotFoundError("Rol bulunamadı");

      const placement = role.placement as RolePlacement;
      if (placementUsesAssignmentGroup(placement) && !entry.groupId) {
        throw new ConflictError(`${role.name} rolü bir grup içinde atanmalı`);
      }
      if (!placementUsesAssignmentGroup(placement) && entry.groupId) {
        throw new ConflictError(
          `${role.name} rolü kapsamını kendisi taşır, ayrıca bir gruba atanamaz`
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
        "Takımın son yöneticisi kaldırılamaz, önce başka bir takım yöneticisi atayın"
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
  const replaceRolesInTransaction = async (
    tx: Prisma.TransactionClient,
    teamId: string,
    accountId: string,
    roles: readonly AccountRoleInput[],
    assignedById: string
  ) => {
    const groupIds = [
      ...new Set(roles.map((entry) => entry.groupId).filter((id): id is string => !!id)),
    ];

    await tx.accountRole.deleteMany({ where: { accountId } });
    await tx.accountRole.createMany({
      data: roles.map((entry) => ({
        accountId,
        roleId: entry.roleId,
        groupId: entry.groupId ?? null,
        assignedById,
      })),
    });
    await Promise.all(
      groupIds.map((groupId) =>
        tx.groupMembership.upsert({
          where: { accountId_groupId: { accountId, groupId } },
          update: { isActive: true },
          create: { accountId, groupId },
        })
      )
    );
  };

  /**
   * Checks a CSV against every rule bulk import enforces, without writing
   * anything.
   *
   * Shared by preview and commit -- commit calls this again itself right
   * before it writes, rather than trusting whatever a client says an earlier
   * preview found, so a stale or forged "this was already validated" can
   * never skip a check.
   */
  const validateBulkImport = async (csv: string) => {
    const parsed = parseAccountsCsv(csv);
    if (parsed.error) {
      return { fileError: parsed.error, rows: [], valid: false };
    }

    const rows = parsed.rows.map((row) => {
      const checked = bulkImportRowSchema.safeParse({ fullName: row.fullName, email: row.email });
      if (!checked.success) {
        return {
          line: row.line,
          fullName: row.fullName,
          email: row.email,
          status: "invalid" as const,
          issues: checked.error.issues.map((issue) => issue.message),
        };
      }
      return {
        line: row.line,
        fullName: checked.data.fullName,
        email: checked.data.email,
        status: "ok" as const,
        issues: [] as string[],
      };
    });

    // A format-valid email repeated in the file is unusable for every row
    // that shares it -- there is no principled way to say which one the
    // address "really" belongs to, so all of them come back for a fix.
    const emailCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.status === "ok") emailCounts.set(row.email, (emailCounts.get(row.email) ?? 0) + 1);
    }
    for (const row of rows) {
      if (row.status === "ok" && (emailCounts.get(row.email) ?? 0) > 1) {
        Object.assign(row, {
          status: "duplicate_in_file" as const,
          issues: ["Bu e-posta dosyada birden fazla kez geçiyor"],
        });
      }
    }

    // Email is unique across the whole platform, not just this team -- see
    // Account.email in schema.prisma and createAdmin in teams.service.ts.
    const candidates = [...new Set(rows.filter((row) => row.status === "ok").map((row) => row.email))];
    if (candidates.length > 0) {
      const existing = await prisma.account.findMany({
        where: { email: { in: candidates } },
        select: { email: true },
      });
      const taken = new Set(existing.map((account) => account.email));
      for (const row of rows) {
        if (row.status === "ok" && taken.has(row.email)) {
          Object.assign(row, {
            status: "duplicate_in_db" as const,
            issues: ["Bu e-posta zaten kullanılıyor"],
          });
        }
      }
    }

    return {
      fileError: null as string | null,
      rows,
      valid: rows.length > 0 && rows.every((row) => row.status === "ok"),
    };
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
      await assertAssignable(teamId, roles);
      const passwordHash = await hashPassword(password);

      const account = await prisma.$transaction(async (tx) => {
        const created = await tx.account.create({
          data: {
            ...rest,
            teamId,
            passwordHash,
            // Whoever typed this password is not the person who will use it,
            // so it is a way in rather than a credential. Cleared by
            // /auth/password. It is deliberately absent from the audit value.
            mustChangePassword: true,
          },
          select: { id: true },
        });

        await replaceRolesInTransaction(tx, teamId, created.id, roles, assignedById);
        await writeAuditLog(tx, {
          teamId,
          actorId: assignedById,
          entityType: "ACCOUNT",
          entityId: created.id,
          action: "ACCOUNT_CREATED",
          newValue: {
            email: rest.email,
            fullName: rest.fullName,
            roles: auditRoles(roles),
          },
        });

        return created;
      });

      const created = await prisma.account.findUniqueOrThrow({
        where: { id: account.id },
        select: accountSelect,
      });
      return (await serializeMany([created]))[0];
    },

    previewBulkImport: (csv: string) => validateBulkImport(csv),

    /**
     * The atomic half of bulk import: every row or none.
     *
     * Re-validates from the raw CSV rather than accepting a client's word that
     * a prior preview passed -- a stale preview, a forged one, or simply
     * someone else taking one of these emails in the meantime all show up the
     * same way here, as a fresh `validateBulkImport` that no longer says ok.
     * When that happens nothing is written; the caller gets the same shape
     * preview already sends, so the form can show exactly what changed.
     *
     * Password hashing happens before the transaction opens: argon2id is
     * deliberately slow, and holding a transaction open for the length of two
     * hundred hashes would starve the connection pool for work the write
     * itself does not need.
     */
    commitBulkImport: async (
      teamId: string,
      csv: string,
      roles: readonly AccountRoleInput[],
      assignedById: string
    ) => {
      const validation = await validateBulkImport(csv);
      if (!validation.valid) {
        return { committed: false as const, ...validation };
      }

      // Same gate POST /accounts and PUT /:id/roles apply -- see
      // assertAssignable's own comment for why this cannot be skipped.
      await assertAssignable(teamId, roles);

      const batchId = randomBytes(9).toString("base64url");
      const passwords = validation.rows.map(() => generateTemporaryPassword(randomBytes));
      const passwordHashes = await mapWithConcurrency(
        passwords,
        PASSWORD_HASH_CONCURRENCY,
        (password) => hashPassword(password)
      );

      try {
        const created = await prisma.$transaction(
          async (tx) => {
            // One more look, as close to the write as it gets: a concurrent
            // import could have taken one of these emails since
            // validateBulkImport ran a moment ago. Finding one here throws
            // and rolls the whole batch back -- see the catch below.
            const emails = validation.rows.map((row) => row.email);
            const collided = await tx.account.findMany({
              where: { email: { in: emails } },
              select: { email: true },
            });
            if (collided.length > 0) {
              throw new ConflictError(
                `${collided.map((account) => account.email).join(", ")} artık kullanılıyor`
              );
            }

            // Prisma/Postgres can return the generated ids for a bulk insert.
            // Doing one INSERT per account (and then one per role, membership
            // and audit row) made a 250-person import hundreds of round trips
            // inside one transaction. The four writes below keep the same
            // all-or-nothing boundary with a constant number of queries.
            const accounts = await tx.account.createManyAndReturn({
              data: validation.rows.map((row, index) => ({
                teamId,
                email: row.email,
                fullName: row.fullName,
                passwordHash: passwordHashes[index]!,
                mustChangePassword: true,
              })),
              select: { id: true, email: true, fullName: true },
            });
            const accountByEmail = new Map(accounts.map((account) => [account.email, account]));

            if (roles.length > 0) {
              await tx.accountRole.createMany({
                data: accounts.flatMap((account) =>
                  roles.map((role) => ({
                    accountId: account.id,
                    roleId: role.roleId,
                    groupId: role.groupId ?? null,
                    assignedById,
                  }))
                ),
              });
            }

            const membershipGroupIds = [
              ...new Set(roles.map((role) => role.groupId).filter((id): id is string => !!id)),
            ];
            if (membershipGroupIds.length > 0) {
              await tx.groupMembership.createMany({
                data: accounts.flatMap((account) =>
                  membershipGroupIds.map((groupId) => ({ accountId: account.id, groupId }))
                ),
              });
            }

            const roleSnapshot = auditRoles(roles);
            await tx.auditLog.createMany({
              data: accounts.map((account) => ({
                teamId,
                actorId: assignedById,
                entityType: "ACCOUNT",
                entityId: account.id,
                action: "ACCOUNT_CREATED",
                // batchId ties every row together while every account keeps a
                // separate, searchable audit entry. Passwords never enter it.
                newValue: {
                  email: account.email,
                  fullName: account.fullName,
                  roles: roleSnapshot,
                  batchId,
                },
              })),
            });

            return validation.rows.map((row, index) => {
              const account = accountByEmail.get(row.email);
              if (!account) throw new Error("Bulk insert did not return a created account");
              return {
                id: account.id,
                email: account.email,
                fullName: account.fullName,
                temporaryPassword: passwords[index]!,
              };
            });
          },
          { timeout: 15_000, maxWait: 10_000 }
        );

        return { committed: true as const, batchId, created };
      } catch (cause) {
        const raceLostHere =
          cause instanceof ConflictError ||
          (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002");
        if (!raceLostHere) throw cause;

        return { committed: false as const, ...(await validateBulkImport(csv)) };
      }
    },

    update: async (teamId: string, id: string, input: UpdateAccountInput) => {
      const existing = await prisma.account.findFirst({
        where: { id, teamId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError("Hesap bulunamadı");

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
      if (!account) throw new NotFoundError("Hesap bulunamadı");

      // Losing the role is what matters, not gaining it: demoting the last team
      // admin is the same lockout as archiving them.
      const wasAdmin = await isTeamAdmin(teamId, id);
      const staysAdmin =
        input.roles.length > 0 &&
        (await prisma.role.count({
          where: { teamId, key: "TEAM_ADMIN", id: { in: input.roles.map((r) => r.roleId) } },
        })) > 0;
      if (wasAdmin && !staysAdmin) await assertNotLastAdmin(teamId, id);

      await assertAssignable(teamId, input.roles);
      await prisma.$transaction(async (tx) => {
        const stored = await tx.accountRole.findMany({
          where: { accountId: id, isActive: true },
          select: { roleId: true, groupId: true },
        });
        const oldValue = auditRoles(stored);
        const newValue = auditRoles(input.roles);

        await replaceRolesInTransaction(tx, teamId, id, input.roles, assignedById);
        if (!auditValuesEqual(oldValue, newValue)) {
          await writeAuditLog(tx, {
            teamId,
            actorId: assignedById,
            entityType: "ACCOUNT",
            entityId: id,
            action: "ACCOUNT_ROLES_REPLACED",
            oldValue,
            newValue,
          });
        }
      });

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
      if (!account) throw new NotFoundError("Hesap bulunamadı");
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
      if (!account) throw new NotFoundError("Hesap bulunamadı");

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
